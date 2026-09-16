import base64
import io
import json
import sys
import warnings

from PIL import Image

Image.MAX_IMAGE_PIXELS = 4_000_000
warnings.simplefilter('error', Image.DecompressionBombWarning)

try:
    data = base64.b64decode(json.load(sys.stdin)['base64'], validate=True)
    assert len(data) <= 128 * 1024
    with Image.open(io.BytesIO(data)) as image:
        assert image.format == 'PNG' and image.width <= 2048 and image.height <= 2048
        assert getattr(image, 'n_frames', 1) == 1
        assert not image.info, 'Image metadata is not accepted'
        image.verify()
    with Image.open(io.BytesIO(data)) as image:
        image.load()
    print(json.dumps({'valid': True}))
except Exception:
    print(json.dumps({'valid': False}))
    sys.exit(1)
