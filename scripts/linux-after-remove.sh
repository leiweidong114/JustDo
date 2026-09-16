#!/bin/sh
set -eu

if [ -L /usr/bin/JustDo-agent ] && [ "$(readlink /usr/bin/JustDo-agent)" = "/opt/JustDo/JustDo-agent" ]; then
  rm -f /usr/bin/JustDo-agent
fi
