#!/bin/bash
T=$(python3 -c "import json,os;d=json.load(open(os.path.expanduser('~/.railway/config.json')));print(d.get('user',{}).get('accessToken') or d.get('user',{}).get('token') or '')")
curl -sS https://backboard.railway.com/graphql/v2 -H "Authorization: Bearer $T" -H 'Content-Type: application/json' -d "$1"; echo
