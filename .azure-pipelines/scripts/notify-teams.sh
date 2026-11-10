#!/usr/bin/env bash
# Posts a build summary to a Teams (Workflows) webhook. Needs: TEAMS_WEBHOOK_URL, SYSTEM_ACCESSTOKEN.
set -euo pipefail
: "${TEAMS_WEBHOOK_URL:?TEAMS_WEBHOOK_URL is not set}"

timeline_url="${SYSTEM_COLLECTIONURI}${SYSTEM_TEAMPROJECT}/_apis/build/builds/${BUILD_BUILDID}/timeline?api-version=7.1"
failed="$(curl -fsS -H "Authorization: Bearer ${SYSTEM_ACCESSTOKEN}" "$timeline_url" |
  jq -r '[.records[] | select(.result=="failed" and (.type=="Stage" or .type=="Job")) | "\(.type) \(.name)"] | unique | join(", ")')"

only_on_failure="$(echo "${ONLY_ON_FAILURE:-false}" | tr '[:upper:]' '[:lower:]')"
if [[ -z "$failed" && "$only_on_failure" == "true" ]]; then
  echo "Build succeeded and ONLY_ON_FAILURE=true; nothing to send."
  exit 0
fi

status="Succeeded"; color="Good"
if [[ -n "$failed" ]]; then status="Failed"; color="Attention"; fi
url="${SYSTEM_COLLECTIONURI}${SYSTEM_TEAMPROJECT}/_build/results?buildId=${BUILD_BUILDID}"

jq -n --arg title "Acme Platform ${BUILD_BUILDNUMBER} - ${status}" \
      --arg branch "${BUILD_SOURCEBRANCHNAME}" --arg by "${BUILD_REQUESTEDFOR}" \
      --arg failed "${failed:-none}" --arg url "$url" --arg color "$color" '
{type:"message",attachments:[{contentType:"application/vnd.microsoft.card.adaptive",content:{
  "$schema":"http://adaptivecards.io/schemas/adaptive-card.json",type:"AdaptiveCard",version:"1.4",
  body:[
    {type:"TextBlock",size:"Medium",weight:"Bolder",text:$title,color:$color},
    {type:"FactSet",facts:[{title:"Branch",value:$branch},{title:"Requested by",value:$by},{title:"Failed",value:$failed}]}
  ],
  actions:[{type:"Action.OpenUrl",title:"Open build",url:$url}]}}]}' |
  curl -fsS -X POST -H 'Content-Type: application/json' -d @- "$TEAMS_WEBHOOK_URL"
