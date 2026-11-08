#!/bin/sh
# Build preview-recorder (small single-file Swift CLI, no SwiftPM, no downloads).
# Output goes to build/ which is git-ignored.
set -eu
cd "$(dirname "$0")"
mkdir -p build
swiftc -parse-as-library -swift-version 5 -O \
  -o build/preview-recorder preview_recorder.swift
echo "built build/preview-recorder"
