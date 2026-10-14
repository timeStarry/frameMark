#!/bin/sh
# Regenerates the committed pipeline fixtures. Requires ImageMagick 7 and
# macOS (for the system Display P3 ICC profile). Outputs are committed so
# tests run anywhere.
#
#   go generate ./internal/media
set -eu
cd "$(dirname "$0")"
# 16x16 flat rgb(200,100,50) tagged with an embedded Display P3 profile.
magick -size 16x16 'xc:rgb(200,100,50)' -quality 95 \
  -profile "/System/Library/ColorSync/Profiles/Display P3.icc" display-p3.jpg
# Two-frame 16x16 animated WebP (red, blue).
magick -size 16x16 xc:red xc:blue -loop 0 -delay 10 anim.webp
