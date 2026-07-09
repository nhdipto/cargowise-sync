export default async function handler(req, res) {
    // 1. Enforce POST requests only
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed. Please use POST.' });
    }

    // 2. CONFIGURATION 
    // CargoWise eAdaptor Credentials
    const cwEndpoint = 'https://pgutrnservices.wisegrid.net/eAdaptor';
    const cwUsername = 'PGUS';
    const cwPassword = 'XMJoa7/xbEOUTnBGwa+nXD/w';

    // Salesforce Partial Sandbox Org Credentials
    const sfTokenUrl = 'https://sourcedirectimports--partial.sandbox.my.salesforce.com/services/oauth2/token';
    const sfRestUrl = 'https://sourcedirectimports--partial.sandbox.my.salesforce.com/services/data/v60.0/sobjects/ContentVersion';
    const sfClientId = '3MVG9WCdh6PFin0i79xoaBNqM3kscnTJo0CzkSnBUjbpsGZ5HndBicDai2qxeolOnMjKRBx4f0XxSxIY9_fzG';
    const sfClientSecret = '2044E3DDBC028C89A20C0DA0E9323F2498A1657B42D96608B02ACE4F15281A45';

    // 3. Extract inputs from Salesforce LWC Button payload
    const { cwKey, salesforceId } = req.body;
    if (!cwKey || !salesforceId) {
        return res.status(400).json({ error: 'Missing cwKey or salesforceId in JSON body.' });
    }

    try {
        // --- 4. AUTHENTICATE WITH SALESFORCE ---
        const authParams = new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: sfClientId,
            client_secret: sfClientSecret
        });

        const authResponse = await fetch(sfTokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: authParams
        });
        
        const authData = await authResponse.json();
        if (!authData.access_token) {
            throw new Error('Salesforce Auth Failed: ' + JSON.stringify(authData));
        }
        const accessToken = authData.access_token;

        // --- 5. FETCH LIVE DATA FROM CARGOWISE ---
        const cwXmlRequest = `<?xml version="1.0" encoding="utf-8"?>
            <UniversalDocumentRequest xmlns="http://www.cargowise.com/Schemas/Universal/2011/11" version="1.1">
                <DocumentRequest>
                    <DataContext>
                        <DataTargetCollection>
                            <DataTarget>
                                <Type>ForwardingShipment</Type>
                                <Key>${cwKey}</Key>
                            </DataTarget>
                        </DataTargetCollection>
                        <Company><Code>AVK</Code></Company>
                        <EnterpriseID>PGU</EnterpriseID>
                        <ServerID>TRN</ServerID>
                    </DataContext>
                </DocumentRequest>
            </UniversalDocumentRequest>`;

        // Convert Username:Password to Base64 for Basic Auth
        const cwAuthHeader = 'Basic ' + Buffer.from(`${cwUsername}:${cwPassword}`).toString('base64');
        
        const cwResponse = await fetch(cwEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/xml',
                'Authorization': cwAuthHeader
            },
            body: cwXmlRequest
        });

        if (!cwResponse.ok) {
            throw new Error(`CargoWise Connection Failed. HTTP Status: ${cwResponse.status}`);
        }
        const cwXmlText = await cwResponse.text();

        // --- 6. PARSE MULTIPLE DOCUMENTS USING REGEX ---
        const documentRegex = /<Document>([\s\S]*?)<\/Document>/g;
        const uploadPromises = [];
        let match;

        while ((match = documentRegex.exec(cwXmlText)) !== null) {
            const documentBlock = match[1];

            // Extract FileName dynamically or create a fallback name
            const nameMatch = documentBlock.match(/<FileName>(.*?)<\/FileName>/);
            const fileName = nameMatch ? nameMatch[1] : `CW_Doc_${cwKey}_${Date.now()}.pdf`;

            // Extract ImageData Base64 binary string stringently
            const dataMatch = documentBlock.match(/<ImageData>(.*?)<\/ImageData>/);
            if (!dataMatch) continue; // Skip if this block happens to lack image data
            const base64Data = dataMatch[1];

            // Prepare individual Salesforce Payload
            const sfPayload = {
                Title: fileName,
                PathOnClient: fileName,
                VersionData: base64Data,
                FirstPublishLocationId: salesforceId
            };

            // Queue up the asynchronous network task without waiting yet
            const uploadTask = fetch(sfRestUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(sfPayload)
            }).then(async (res) => {
                const data = await res.json();
                if (!res.ok) throw new Error(`Failed uploading ${fileName}: ${JSON.stringify(data)}`);
                return { fileName, contentVersionId: data.id, status: 'Success' };
            }).catch(err => ({ fileName, status: 'Failed', error: err.message }));

            uploadPromises.push(uploadTask);
        }

        // Return error if zero file segments were parsed out
        if (uploadPromises.length === 0) {
            return res.status(404).json({ error: `No valid ImageData files discovered in CargoWise for shipment reference: ${cwKey}` });
        }

        // --- 7. EXECUTE STREAM UPLOADS CONCURRENTLY TO SALESFORCE ---
        // Pushes all files simultaneously using Promise.all to bypass transactional timeout windows
        const results = await Promise.all(uploadPromises);

        // --- 8. RETURN BATCH RESPONSE TO LWC ---
        return res.status(201).json({ 
            success: true, 
            totalFilesProcessed: results.length,
            files: results
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}
