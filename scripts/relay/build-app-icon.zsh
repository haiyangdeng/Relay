#!/bin/zsh
set -euo pipefail
if (( $# != 0 )); then
  print -u2 'Builds only the fixed Relay macOS App icon resources.'
  exit 64
fi
project_dir="${0:A:h:h:h}"
source="$project_dir/build/relay-app-icon-source.png"
iconset="$project_dir/build/relay.iconset"
mkdir -p "$iconset"
# The source already contains the transparent padding and rounded
# artwork. sips only generates required icon resolutions; it does not crop,
# recolor, mask or redraw the mascot. iconutil performs the macOS packaging.
/usr/bin/sips -z 1024 1024 "$source" --out "$project_dir/build/relay-1024.png" >/dev/null
for entry in '16x16:16' '16x16@2x:32' '32x32:32' '32x32@2x:64' '128x128:128' '128x128@2x:256' '256x256:256' '256x256@2x:512' '512x512:512' '512x512@2x:1024'; do
  name="${entry%:*}"
  size="${entry##*:}"
  /usr/bin/sips -z "$size" "$size" "$source" --out "$iconset/icon_$name.png" >/dev/null
done
/usr/bin/iconutil --convert icns --output "$project_dir/build/relay.icns" "$iconset"
print 'Relay App icon resources generated. No installed App or icon cache was changed.'
