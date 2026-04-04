#!/bin/bash
cd "$(dirname "$0")" && cp -n .env.example .env 2>/dev/null; npm install --production --silent && npm start
