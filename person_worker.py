# YOLO-воркер: ищет людей на кадре и считает, сколько из них в зоне станка.
# Протокол (stdin/stdout, по строке JSON):
#   запрос:  {"file": "кадр.jpg", "zone": [[x,y],...] (доли 0..1, необязательно), "out": "debug.jpg" (необязательно)}
#   ответ:   {"ok": true, "people": N, "inZone": M}  или  {"ok": false, "error": "..."}
#   при старте печатает {"ready": true}
import sys, json
import cv2
import numpy as np
from ultralytics import YOLO

model = YOLO('yolov8n.pt')
print(json.dumps({'ready': True}), flush=True)

# цвета в формате BGR (как в OpenCV)
ZONE_COLOR = (255, 0, 0)      # синяя зона станка
PERSON_OUT = (0, 200, 0)      # человек вне зоны
PERSON_IN = (0, 0, 255)       # человек в зоне


def draw(img, poly, boxes, out):
    if poly is not None:
        cv2.polylines(img, [poly.astype(np.int32)], True, ZONE_COLOR, 3)
        cv2.putText(img, 'ZONE', (int(poly[0][0]) + 5, int(poly[0][1]) + 25), cv2.FONT_HERSHEY_SIMPLEX, 0.8, ZONE_COLOR, 2)
    for (x1, y1, x2, y2, conf, inside) in boxes:
        c = PERSON_IN if inside else PERSON_OUT
        cv2.rectangle(img, (x1, y1), (x2, y2), c, 3)
        cv2.circle(img, ((x1 + x2) // 2, int(y1 + (y2 - y1) * 0.55)), 7, c, -1)
        label = 'person %.2f%s' % (conf, ' IN ZONE' if inside else '')
        cv2.putText(img, label, (x1, max(y1 - 8, 20)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, c, 2)
    cv2.imwrite(out, img)


for line in sys.stdin:
    try:
        req = json.loads(line)
        img = cv2.imread(req['file'])
        h, w = img.shape[:2]
        zone = req.get('zone')
        poly = None
        if zone:
            poly = np.array([[x * w, y * h] for x, y in zone], np.float32)
        res = model.predict(img, classes=[0], conf=0.4, imgsz=640, verbose=False)[0]
        people = 0
        in_zone = 0
        boxes = []
        for b in res.boxes:
            x1, y1, x2, y2 = [int(v) for v in b.xyxy[0].tolist()]
            people += 1
            inside = False
            if poly is not None:
                # точка на уровне пояса: центр по ширине, 55% высоты рамки сверху
                inside = cv2.pointPolygonTest(poly, ((x1 + x2) / 2, y1 + (y2 - y1) * 0.55), False) >= 0
            if inside:
                in_zone += 1
            boxes.append((x1, y1, x2, y2, float(b.conf[0]), inside))
        if req.get('out'):
            draw(img, poly, boxes, req['out'])
        print(json.dumps({'ok': True, 'people': people, 'inZone': in_zone}), flush=True)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}), flush=True)
