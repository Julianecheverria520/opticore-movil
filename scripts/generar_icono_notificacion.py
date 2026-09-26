"""
Ícono de la notificación del GPS ("Viaje en curso", servicio en primer plano de expo-location).

Android pinta estos íconos como silueta: deben ser BLANCOS sobre transparente. Es el cubo del
logo de OptiCore (cara de arriba en 2x2, cara izquierda en dos bloques), dibujado limpio para
que se lea a 24 px. Genera assets/notificacion/<densidad>.png; plugins/icono-notificacion.js
los copia como drawable `notification_icon`, que expo-location usa antes que el ícono de la app.

    py scripts/generar_icono_notificacion.py
"""
import sys
from PIL import Image, ImageDraw

def cubo(lado_px, relleno=0.10, hueco=0.055, ss=8):
    S = lado_px * ss
    a = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(a)
    alto = S * (1 - 2 * relleno)
    ancho = alto * 0.80                     # proporción del cubo del logo (335 x 420)
    x0 = (S - ancho) / 2; y0 = S * relleno
    P = lambda u, v: (x0 + u * ancho, y0 + v * alto)
    T, L, R, C = P(.5, 0), P(0, .25), P(1, .25), P(.5, .5)
    BL, BR, B = P(0, .75), P(1, .75), P(.5, 1)
    for cara in ((T, R, C, L), (L, C, B, BL), (C, R, BR, B)):
        d.polygon(cara, fill=255)
    m = lambda p, q: ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
    g = max(1, round(S * hueco))
    cortes = [(L, C), (C, R), (C, B),               # aristas entre caras
              (m(T, L), m(R, C)), (m(T, R), m(L, C)),  # cuadrícula 2x2 de la cara de arriba
              (m(L, C), m(BL, B))]                  # cara izquierda en dos bloques
    for p, q in cortes:
        d.line([p, q], fill=0, width=g)
    a = a.resize((lado_px, lado_px), Image.LANCZOS)
    img = Image.new('RGBA', (lado_px, lado_px), (255, 255, 255, 0))
    img.putalpha(a)
    return img


DENSIDADES = {'mdpi': 24, 'hdpi': 36, 'xhdpi': 48, 'xxhdpi': 72, 'xxxhdpi': 96}

if __name__ == '__main__':
    import os
    destino = os.path.join(os.path.dirname(__file__), '..', 'assets', 'notificacion')
    os.makedirs(destino, exist_ok=True)
    for nombre, lado in DENSIDADES.items():
        cubo(lado).save(os.path.join(destino, f'{nombre}.png'), optimize=True)
        print(nombre, lado)
