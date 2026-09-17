// TEMPORARY — paste into the browser console while on
// https://parkersmithh.github.io/CybercabHunter/ (any page, must be logged
// in via "Link Tesla Account" first). Not loaded by the site itself, not
// referenced anywhere, safe to delete after use.
//
// What it does: reads your session ID from localStorage (never printed,
// never sent anywhere except the Worker API below), generates a tiny PNG
// entirely in memory, uploads it as a test submission, lists it back,
// fetches the evidence back, then deletes both the submission and its R2
// object via the real DELETE /api/submissions/:id endpoint. Ends with
// production containing zero test rows/objects if every step succeeds.

(async () => {
  const WORKER = 'https://cybercabhunter.contactjoeclos.workers.dev';

  const sessionId = localStorage.getItem('teslaSessionId');
  if (!sessionId) {
    console.log('❌ Not authenticated — no teslaSessionId in localStorage. Link your Tesla account first.');
    return;
  }
  const authHeader = { Authorization: `Bearer ${sessionId}` }; // never logged below

  function tinyPng() {
    // Smallest valid 1x1 transparent PNG, as bytes — generated locally, not fetched.
    const base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
  }

  let submissionId = null;

  try {
    console.log('Step 1: uploading test submission...');
    const form = new FormData();
    form.append('submission_type', 'ride_receipt');
    form.append('evidence_type', 'receipt');
    form.append('evidence', tinyPng(), 'test.png');

    const createResp = await fetch(`${WORKER}/api/submissions`, {
      method: 'POST',
      headers: authHeader,
      body: form
    });
    const createJson = await createResp.json();
    console.log('Create response:', createResp.status, createJson);

    if (!createResp.ok || !createJson.success) {
      console.log('❌ Stopping — create failed.');
      return;
    }
    submissionId = createJson.submission.id;

    console.log('Step 2: listing submissions...');
    const listResp = await fetch(`${WORKER}/api/submissions`, { headers: authHeader });
    const listJson = await listResp.json();
    console.log('List response:', listResp.status, listJson);

    console.log('Step 3: fetching evidence back...');
    const evidenceResp = await fetch(`${WORKER}/api/submissions/${submissionId}/evidence`, { headers: authHeader });
    console.log('Evidence response status:', evidenceResp.status, 'content-type:', evidenceResp.headers.get('content-type'));
    if (evidenceResp.ok && evidenceResp.headers.get('content-type') === 'image/png') {
      console.log('✅ Evidence retrieval OK — correct content type.');
    } else {
      console.log('⚠️ Evidence retrieval did not look right.');
    }
  } catch (err) {
    console.log('❌ Error during test:', err.message);
  } finally {
    if (submissionId) {
      console.log('Step 4: cleaning up test submission...');
      const delResp = await fetch(`${WORKER}/api/submissions/${submissionId}`, {
        method: 'DELETE',
        headers: authHeader
      });
      const delJson = await delResp.json().catch(() => null);
      console.log('Delete response:', delResp.status, delJson);
      if (delResp.ok && delJson && delJson.success) {
        console.log('✅ Cleanup confirmed — test submission and its evidence were deleted.');
      } else {
        console.log('❌ Cleanup did NOT confirm success — tell Claude before assuming production is clean.');
      }
    }
  }
})();
