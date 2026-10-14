#!/bin/sh
# Regenerates the committed pipeline fixtures (anim.webp, display-p3.jpg).
#
# Requirements: macOS (it reads the system "Display P3.icc" from
# /System/Library/ColorSync/Profiles) and ImageMagick 7 (`magick`).
#
# The outputs are COMMITTED and tests only read them; nothing regenerates
# them during `go test`. Rerunning this script on another ImageMagick or
# libjpeg version produces different bytes, so commit a regeneration only
# when the fixtures themselves must change. Do not run it on Linux CI.
#
#   sh internal/media/testdata/gen.sh   (or: go generate ./internal/media)
set -eu
cd "$(dirname "$0")"
# 16x16 flat rgb(200,100,50) tagged with an embedded Display P3 profile.
magick -size 16x16 'xc:rgb(200,100,50)' -quality 95 \
  -profile "/System/Library/ColorSync/Profiles/Display P3.icc" display-p3.jpg
# Two-frame 16x16 animated WebP (red, blue).
magick -size 16x16 xc:red xc:blue -loop 0 -delay 10 anim.webp
