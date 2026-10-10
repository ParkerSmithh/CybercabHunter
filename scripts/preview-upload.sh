#!/bin/sh
# Uploads the current code as a PREVIEW version (never production traffic):
#   sh scripts/preview-upload.sh <alias>   ->  https://<alias>-cybercabhunter.contactjoeclos.workers.dev
# The preview gets its own data, so it can never change production's:
#   D1  cybercabhunter-news-preview        (not cybercabhunter-db)
#   R2  cybercabhunter-news-thumbs-preview (not cybercabhunter-news-thumbs)
#   KV  PREVIEW_SESSIONS 2a443ef2…         (not TESLA_SESSIONS; sign-ins don't carry over)
# Preview versions don't run the cron schedule. The temporary config is deleted.
set -e
ALIAS="${1:?usage: sh scripts/preview-upload.sh <alias>}"
cd "$(dirname "$0")/.."
sed -e 's/"cybercabhunter-db"/"cybercabhunter-news-preview"/' \
    -e 's/1873d232-f799-4a4c-915a-615df4556841/4f2e6c90-6fbb-41ce-814d-9eaaef194e55/' \
    -e 's/"cybercabhunter-news-thumbs"/"cybercabhunter-news-thumbs-preview"/' \
    -e 's/3b4c90b3fd1b40efbc5722fea72d90c0/2a443ef29b2a40ec83e46cf0fccd6557/' \
    wrangler.jsonc > wrangler.preview.jsonc
trap 'rm -f wrangler.preview.jsonc' EXIT
# Refuse to upload if any production binding survived the swap.
if grep -qE '1873d232-f799|"cybercabhunter-news-thumbs"|3b4c90b3fd1b40ef' wrangler.preview.jsonc; then
  echo "preview config still points at production; not uploading" >&2; exit 1
fi
npx wrangler versions upload -c wrangler.preview.jsonc --preview-alias "$ALIAS"
