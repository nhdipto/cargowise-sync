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

    // Salesforce Dev Org Credentials
    const sfTokenUrl = 'https://fslsecondarydemo-dev-ed.develop.my.salesforce.com/services/oauth2/token';
    const sfRestUrl = 'https://fslsecondarydemo-dev-ed.develop.my.salesforce.com/services/data/v60.0/sobjects/ContentVersion';
    const sfClientId = '3MVG9Gm6vbdjgMWRlURdLXMlIG_tgrmt5KpI.I4ma2uUHYz1EiXkGUM8ZQ7ekpP5co9tMdXIKcaLrQ0H7aivR';
    const sfClientSecret = '8B2C63D9643A65D05B954C1A9AD717485F3D87308865BC036D6665E6F6E53C1C';

    // 3. Extract inputs from Postman/Salesforce
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

        // --- 6. EXTRACT BASE64 DATA FAST (String Slicing) ---
        const startTag = '<ImageData>';
        const endTag = '</ImageData>';
        const startPos = cwXmlText.indexOf(startTag);
        
        if (startPos === -1) {
            throw new Error(`No ImageData found in CargoWise response for Key: ${cwKey}`);
        }
        
        const exactStart = startPos + startTag.length;
        const exactEnd = cwXmlText.indexOf(endTag, exactStart);
        const base64Data = cwXmlText.substring(exactStart, exactEnd);

        // --- 7. PUSH DIRECTLY TO SALESFORCE REST API ---
        const sfPayload = {
            Title: `CW_Document_${cwKey}.pdf`,
            PathOnClient: `CW_Document_${cwKey}.pdf`,
            VersionData: base64Data,
            FirstPublishLocationId: salesforceId
        };

        const sfUploadResponse = await fetch(sfRestUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(sfPayload)
        });

        const sfUploadData = await sfUploadResponse.json();

        if (!sfUploadResponse.ok) {
            throw new Error(`Salesforce Upload Failed: ${JSON.stringify(sfUploadData)}`);
        }

        // --- 8. RETURN SUCCESS ---
        return res.status(201).json({ 
            success: true, 
            contentVersionId: sfUploadData.id 
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}