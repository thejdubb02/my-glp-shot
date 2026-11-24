#!/usr/bin/env python3
"""Offline check of scripts/weekly-audit.py: no network, no keys, no OpenRouter.

A model that answers with content null used to make _post() return None, and the
audit crashed writing it to a file (2026-11-22). _post() must always return text.
"""
import importlib.util
import io
import json
import pathlib
import sys
from unittest import mock

here = pathlib.Path(__file__).parent
with mock.patch.object(pathlib.Path, 'read_text', return_value=''):   # key files do not exist here
    spec = importlib.util.spec_from_file_location('weekly_audit', here / 'weekly-audit.py')
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)


def reply(payload):
    with mock.patch.object(audit.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(payload).encode())):
        return audit._post('https://example.invalid', {}, {}, extract='openai')


cases = {
    'normal reply is passed through': (reply({'choices': [{'message': {'content': '- [HIGH] x'}}]}), '- [HIGH] x'),
    'null content becomes text': (reply({'choices': [{'message': {'content': None}}]})[:16], '[empty response]'),
    'blank content becomes text': (reply({'choices': [{'message': {'content': ''}}]})[:16], '[empty response]'),
    'no choices becomes text': (reply({'error': 'x'})[:20], '[malformed response]'),
}
failed = [name for name, (got, want) in cases.items() if got != want]
print(f'{len(cases) - len(failed)} passed, {len(failed)} failed')
for name in failed:
    print(f'  ✗ {name}')
sys.exit(1 if failed else 0)
