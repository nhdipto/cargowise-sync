export default async function handler(req, res) {
    // --- 1. HANDLE CORS HANDSHAKE FOR BROWSER SECURITY ---
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed. Please use POST.' });
    }

    // 2. CONFIGURATION 
    const cwEndpoint = 'https://pgutrnservices.wisegrid.net/eAdaptor';
    const cwUsername = 'PGUS';
    const cwPassword = 'XMJoa7/xbEOUTnBGwa+nXD/w';

    const sfTokenUrl = 'https://sourcedirectimports--partial.sandbox.my.salesforce.com/services/oauth2/token';
    const sfRestUrl = 'https://sourcedirectimports--partial.sandbox.my.salesforce.com/services/data/v60.0/sobjects/ContentVersion';
    const sfQueryUrl = 'https://sourcedirectimports--partial.sandbox.my.salesforce.com/services/data/v60.0/query';
    const sfClientId = '3MVG9WCdh6PFin0i79xoaBNqM3kscnTJo0CzkSnBUjbpsGZ5HndBicDai2qxeolOnMjKRBx4f0XxSxIY9_fzG';
    const sfClientSecret = '2044E3DDBC028C89A20C0DA0E9323F2498A1657B42D96608B02ACE4F15281A45';

    // 3. Extract inputs from payload
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

        // --- 4b. FETCH CURRENTLY ATTACHED FILES FOR DEDUPLICATION ---
        // Pull titles of files already attached to this record to prevent double uploads
        const soqlQuery = `SELECT Title FROM ContentVersion WHERE FirstPublishLocationId = '${salesforceId}' AND IsLatest = true`;
        const queryResponse = await fetch(`${sfQueryUrl}?q=${encodeURIComponent(soqlQuery)}`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const queryData = await queryResponse.json();
        const existingFileNames = new Set(
            (queryData.records || []).map(record => record.Title.toLowerCase())
        );

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
                    <DocumentTypeCollection Content="Complete">
                        <DocumentType>
                            <IncludeUnapprovedDocuments>true</IncludeUnapprovedDocuments>
                        </DocumentType>
                    </DocumentTypeCollection>
                </DocumentRequest>
            </UniversalDocumentRequest>`;

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

        // --- 6. GLOBAL IMAGE DATA EXTRACTION ENGINE ---
        const imageDataRegex = /<[^:>]*?ImageData>([\s\S]*?)<\/[^:>]*?ImageData>/g;
        const uploadPromises = [];
        let match;
        let fileIndex = 1;

        while ((match = imageDataRegex.exec(cwXmlText)) !== null) {
            const base64Data = match[1].trim();
            if (!base64Data) continue;

            const searchWindowStart = Math.max(0, match.index - 5000);
            const contextChunk = cwXmlText.substring(searchWindowStart, match.index);
            
            const nameMatch = contextChunk.match(/<[^:>]*?FileName>([^<]*?)<\/[^:>]*?FileName>/g);
            let fileName = '';
            
            if (nameMatch && nameMatch.length > 0) {
                const lastRawTag = nameMatch[nameMatch.length - 1];
                fileName = lastRawTag.replace(/<[^>]*?>/g, '').trim();
            }

            if (!fileName) {
                fileName = `CargoWise_Attachment_${fileIndex}_${cwKey}.pdf`;
            }

            fileIndex++;

            // --- 6b. CRITICAL DEDUPLICATION CHECK ---
            if (existingFileNames.has(fileName.toLowerCase())) {
                // Skip uploading this file since an asset with the exact name is already linked
                uploadPromises.push(Promise.resolve({ fileName, status: 'Skipped (Duplicate)' }));
                continue;
            }

            const sfPayload = {
                Title: fileName,
                PathOnClient: fileName,
                VersionData: base64Data,
                FirstPublishLocationId: salesforceId
            };

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

        if (uploadPromises.length === 0) {
            return res.status(404).json({ error: `No valid ImageData files discovered in CargoWise payload for reference: ${cwKey}` });
        }

        // --- 7. CONCURRENTLY UPLOAD DATA STREAMS TO SALESFORCE ---
        const results = await Promise.all(uploadPromises);

        // Filter total processed files count to reflect only fresh uploads
        const actualUploadsCount = results.filter(f => f.status === 'Success').length;

        return res.status(201).json({ 
            success: true, 
            totalFilesProcessed: actualUploadsCount,
            files: results
        });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}
