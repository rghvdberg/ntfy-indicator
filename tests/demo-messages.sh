#!/bin/bash
# Send ~20 demo messages per topic to the dev ntfy server across a few fresh
# topics, so the VM extension starts from a clean backlog and you can test
# topic switching, per-topic counts, and history limits.
#
# Usage:
#   ./tests/demo-messages.sh
#
# Then in the VM preferences add the printed topics to the channels list.

set -euo pipefail

cd "$(dirname "$0")/.."

SERVER="https://server.cup.cake:12707"
STAMP="$(head -c256 /dev/urandom | LC_ALL=C tr -dc 'a-z' | head -c5)"
FIXTURES="tests/fixtures"

ALERTS="demo-${STAMP}-alerts"
IMAGES="demo-${STAMP}-images"
FILES="demo-${STAMP}-files"
CHAT="demo-${STAMP}-chat"

send() {
  local topic="$1"
  shift
  curl -sk "$@" "${SERVER}/${topic}"
}

send_attachment() {
  local topic="$1" file="$2" filename="$3"
  shift 3
  curl -sk -T "${file}" \
    -H "Filename: ${filename}" \
    "$@" \
    "${SERVER}/${topic}"
}

echo "Sending ~20 demo messages per topic to:"
echo "  ${ALERTS}"
echo "  ${IMAGES}"
echo "  ${FILES}"
echo "  ${CHAT}"
echo

# === alerts: priorities, tags, click URLs ===
send "${ALERTS}" -d "Plain alert"
send "${ALERTS}" -d "Disk space low" -H "Title: Alert" -H "Priority: 5"
send "${ALERTS}" -d "Daily summary ready" -H "Title: Summary" -H "Priority: 1"
send "${ALERTS}" -d "Tagged alert" -H "Title: Tagged" -H "Tags: prod,warning"
send "${ALERTS}" -d "Open the dashboard" -H "Title: Click action" -H "Click: https://ntfy.sh/docs"
send "${ALERTS}" -d "Server reboot required" -H "Title: Reboot" -H "Priority: 4"
send "${ALERTS}" -d "Backup completed successfully" -H "Title: Backup" -H "Priority: 2" -H "Click: https://ntfy.sh"
send "${ALERTS}" -d "CPU usage above threshold" -H "Title: CPU" -H "Priority: 5" -H "Tags: critical"
send "${ALERTS}" -d "Memory usage normal" -H "Title: Memory" -H "Priority: 2" -H "Tags: info"
send "${ALERTS}" -d "Deployment started" -H "Title: Deploy" -H "Tags: dev,deploy"
send "${ALERTS}" -d "Deployment finished" -H "Title: Deploy done" -H "Tags: dev,deploy" -H "Priority: 3"
send "${ALERTS}" -d "Open GitHub" -H "Title: GitHub" -H "Click: https://github.com"
send "${ALERTS}" -d "Service degraded" -H "Title: Degraded" -H "Priority: 4"
send "${ALERTS}" -d "Service recovered" -H "Title: Recovered" -H "Priority: 3" -H "Click: https://status.github.com"
send "${ALERTS}" -d "Heartbeat check" -H "Title: Heartbeat" -H "Priority: 1"
send "${ALERTS}" -d "Security patch available" -H "Title: Patch" -H "Priority: 4" -H "Tags: security"
send "${ALERTS}" -d "Log rotation complete" -H "Title: Logs" -H "Tags: maintenance"
send "${ALERTS}" -d "Certificate expires soon" -H "Title: TLS" -H "Priority: 5"
send "${ALERTS}" -d "Scheduled maintenance tonight" -H "Title: Maintenance" -H "Priority: 2"
send "${ALERTS}" -d "All systems operational" -H "Title: Status" -H "Priority: 1"

# === images: image attachments in various formats and shapes ===
send_attachment "${IMAGES}" "${FIXTURES}/img01.png" "img01.png" -H "Title: Wide PNG" -H "Message: Wide screenshot"
send_attachment "${IMAGES}" "${FIXTURES}/img02.png" "img02.png" -H "Title: Tall PNG" -H "Message: Tall image preview"
send_attachment "${IMAGES}" "${FIXTURES}/img04.png" "img04.png" -H "Title: Square PNG" -H "Message: Square image preview"
send_attachment "${IMAGES}" "${FIXTURES}/img05.jpg" "img05.jpg" -H "Title: JPG photo" -H "Message: A JPG sample"
send_attachment "${IMAGES}" "${FIXTURES}/img06.webp" "img06.webp" -H "Title: WebP image" -H "Message: WebP sample"
send_attachment "${IMAGES}" "${FIXTURES}/img07.png" "img07.png" -H "Title: Tagged image" -H "Message: Image with tags" -H "Tags: demo,image" -H "Priority: 4"
send_attachment "${IMAGES}" "${FIXTURES}/img03.png" "img03.png" -H "Title: Image with click" -H "Message: Click the banner" -H "Click: https://ntfy.sh"
send_attachment "${IMAGES}" "${FIXTURES}/img01.png" "img01-2.png" -H "Title: Another wide" -H "Message: Wide again" -H "Click: https://ntfy.sh"
send_attachment "${IMAGES}" "${FIXTURES}/img02.png" "img02-2.png" -H "Title: Another tall" -H "Message: Tall again"
send_attachment "${IMAGES}" "${FIXTURES}/img04.png" "img04-2.png" -H "Title: Another square" -H "Message: Square again" -H "Click: https://docs.gtk.org/gtk4/"
send_attachment "${IMAGES}" "${FIXTURES}/img05.jpg" "img05-2.jpg" -H "Title: Another JPG" -H "Message: JPG again"
send_attachment "${IMAGES}" "${FIXTURES}/img06.webp" "img06-2.webp" -H "Title: Another WebP" -H "Message: WebP again"
send_attachment "${IMAGES}" "${FIXTURES}/img07.png" "img07-2.png" -H "Title: Another tagged" -H "Message: Tagged again" -H "Tags: demo,image"
send_attachment "${IMAGES}" "${FIXTURES}/img03.png" "img03-2.png" -H "Title: Another click" -H "Message: Click again" -H "Click: https://ntfy.sh"
send_attachment "${IMAGES}" "${FIXTURES}/img01.png" "img01-p5.png" -H "Title: Priority image" -H "Message: High priority image" -H "Priority: 5"
send_attachment "${IMAGES}" "${FIXTURES}/img02.png" "img02-tags.png" -H "Title: Tags image" -H "Message: Tagged tall image" -H "Tags: demo,tall"
send_attachment "${IMAGES}" "${FIXTURES}/img04.png" "img04-click.png" -H "Title: Click square" -H "Message: Click this square" -H "Click: https://ntfy.sh/docs"
send_attachment "${IMAGES}" "${FIXTURES}/img05.jpg" "img05-p1.jpg" -H "Title: Low priority photo" -H "Message: Low priority JPG" -H "Priority: 1"
send_attachment "${IMAGES}" "${FIXTURES}/img06.webp" "img06-msg.webp" -H "Title: WebP with message" -H "Message: This is a webp"
send_attachment "${IMAGES}" "${FIXTURES}/img07.png" "img07-final.png" -H "Title: Final image" -H "Message: Last image"

# === files: non-image attachments ===
send_attachment "${FILES}" "${FIXTURES}/notes.txt" "notes.txt" -H "Title: Text file" -H "Message: Some notes attached"
send_attachment "${FILES}" "${FIXTURES}/lorem.pdf" "lorem.pdf" -H "Title: PDF document" -H "Message: A PDF attachment"
send_attachment "${FILES}" "${FIXTURES}/data.bin" "data.bin" -H "Title: Binary data" -H "Message: Raw binary attachment"
send_attachment "${FILES}" "${FIXTURES}/archive.zip" "archive.zip" -H "Title: Zip archive" -H "Message: An archive"
send_attachment "${FILES}" "${FIXTURES}/notes.txt" "notes-2.txt" -H "Title: More notes" -H "Message: More notes attached" -H "Click: https://ntfy.sh"
send_attachment "${FILES}" "${FIXTURES}/lorem.pdf" "lorem-2.pdf" -H "Title: Another PDF" -H "Message: Another PDF" -H "Click: https://extensions.gnome.org"
send_attachment "${FILES}" "${FIXTURES}/data.bin" "data-2.bin" -H "Title: More binary" -H "Message: More binary data"
send_attachment "${FILES}" "${FIXTURES}/archive.zip" "archive-2.zip" -H "Title: Another zip" -H "Message: Another archive"
send_attachment "${FILES}" "${FIXTURES}/notes.txt" "notes-prio.txt" -H "Title: Priority text" -H "Message: Text with priority" -H "Priority: 4"
send_attachment "${FILES}" "${FIXTURES}/lorem.pdf" "lorem-tags.pdf" -H "Title: Tagged PDF" -H "Message: PDF with tags" -H "Tags: docs,pdf"
send_attachment "${FILES}" "${FIXTURES}/data.bin" "data-click.bin" -H "Title: Click binary" -H "Message: Binary with click" -H "Click: https://ntfy.sh"
send_attachment "${FILES}" "${FIXTURES}/archive.zip" "archive-titled.zip" -H "Title: Titled zip" -H "Message: Zip with title"
send_attachment "${FILES}" "${FIXTURES}/notes.txt" "notes-3.txt" -H "Title: Plain notes" -H "Message: Just notes" -H "Click: https://ntfy.sh/docs"
send_attachment "${FILES}" "${FIXTURES}/lorem.pdf" "lorem-3.pdf" -H "Title: Plain PDF" -H "Message: Just a PDF"
send_attachment "${FILES}" "${FIXTURES}/data.bin" "data-3.bin" -H "Title: Plain binary" -H "Message: Just binary"
send_attachment "${FILES}" "${FIXTURES}/archive.zip" "archive-3.zip" -H "Title: Plain zip" -H "Message: Just a zip"
send_attachment "${FILES}" "${FIXTURES}/notes.txt" "notes-final.txt" -H "Title: Final notes" -H "Message: Last notes"
send_attachment "${FILES}" "${FIXTURES}/lorem.pdf" "lorem-final.pdf" -H "Title: Final PDF" -H "Message: Last PDF"
send_attachment "${FILES}" "${FIXTURES}/data.bin" "data-final.bin" -H "Title: Final binary" -H "Message: Last binary"
send_attachment "${FILES}" "${FIXTURES}/archive.zip" "archive-final.zip" -H "Title: Final zip" -H "Message: Last zip"

# === chat: plain / unicode / long messages ===
send "${CHAT}" -d "Hey, anyone around?"
send "${CHAT}" -d "Build succeeded 🎉" -H "Title: CI"
send "${CHAT}" -d "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat." -H "Title: Long message"
send "${CHAT}" -d "Last message" -H "Title: Final"
send "${CHAT}" -d "Morning! ☕" -H "Title: Morning" -H "Click: https://ntfy.sh"
send "${CHAT}" -d "How is it going?" -H "Click: https://github.com"
send "${CHAT}" -d "Meeting in 5 minutes" -H "Title: Meeting"
send "${CHAT}" -d "Coffee break?" -H "Title: Coffee"
send "${CHAT}" -d "Looks good to me 👍" -H "Title: LGTM"
send "${CHAT}" -d "Replied in the other thread" -H "Title: Thread"
send "${CHAT}" -d "Random thought: tabs are better than spaces" -H "Title: Hot take"
send "${CHAT}" -d "Another message"
send "${CHAT}" -d "Short"
send "${CHAT}" -d "Hello world"
send "${CHAT}" -d "Demo message" -H "Click: https://extensions.gnome.org"
send "${CHAT}" -d "Test 123"
send "${CHAT}" -d "Launch time 🚀🌟💻" -H "Title: Launch"
send "${CHAT}" -d "This is another long-ish message to make sure wrapping and layout behave reasonably in the history dialog when there is a lot of text to display." -H "Title: Wrap test"
send "${CHAT}" -d "Almost done with the demo"
send "${CHAT}" -d "That's all folks" -H "Title: The end"

echo
echo "Done. Add these channels in the VM extension preferences:"
echo "  ${ALERTS}"
echo "  ${IMAGES}"
echo "  ${FILES}"
echo "  ${CHAT}"
