"""Mandatory RFC3339 validation independent of optional jsonschema extras."""
import re
from datetime import datetime
from jsonschema import FormatChecker

format_checker = FormatChecker()


@format_checker.checks('date-time', raises=(ValueError, TypeError))
def date_time(value):
    if not isinstance(value, str):
        return True
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)', value):
        return False
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    return parsed.tzinfo is not None
