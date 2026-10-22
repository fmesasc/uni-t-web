# UNI-T Web

Interfaz web para leer multímetros **UNI-T** desde Linux (sin el software de Windows).
Muestra el valor en vivo, gráfica, estadísticas, permite grabar sesiones, guardar capturas
puntuales con notas y exportar todo a CSV.

Pensado para el **UT61C** (cable USB UT-D04). Los protocolos están sacados de libsigrok,
de proyectos de la comunidad y del análisis del software oficial (UT61C_D V3.03 / UT61E V4.01).

## Modelos y cables

| Modelo | Chip / protocolo | Velocidad | Estado |
|---|---|---|---|
| UT61B, **UT61C**, UT61D | FS9922-DMM4, 14 bytes ASCII | 2400 8N1 | soportado |
| UT61E | ES51922, 14 bytes | 19200 7O1 | soportado (sin probar con hardware) |
| UT60A, UT60E | FS9721, 14 bytes segmentos | 2400 8N1 | soportado (sin probar con hardware) |
| UT61B+, UT61D+, UT61E+, UT161B/D/E | protocolo propio `AB CD`, por petición | 9600 8N1 (CP2110) | experimental (sin probar con hardware) |

Cables:

- **UT-D04** (USB, el más habitual): es un chip HID (`1a86:e008` WCH CH9325 o `04fa:2490` Hoitek HE2325U).
  No crea `/dev/ttyUSB*`; se lee directamente por `/dev/hidrawN`, sin libusb.
- **UT61+ / UT161**: el cable USB lleva un CP2110 (`10c4:ea80`), también HID. A estos hay que
  pedirles cada lectura; el programa lo hace unas 3 veces por segundo.
- **UT-D02** (RS-232) o adaptadores USB-serie: aparece como `/dev/ttyUSB*` / `/dev/ttyS*`.
  El programa pone DTR=1 y RTS=0, que es lo que alimenta el receptor óptico.

> En el multímetro hay que **activar el envío de datos**: en el UT61C, mantener pulsado
> `REL/RS232` hasta que aparezca `RS232` en la pantalla. Si la web dice
> *"Sin datos — ¿multímetro encendido y en modo RS232?"* casi siempre es esto.
> El auto-apagado se desactiva solo en modo RS232.

## Instalación

```bash
python3 -m venv .venv
.venv/bin/pip install -e .
```

Permisos del cable USB (una vez):

```bash
sudo cp udev/70-uni-t.rules /etc/udev/rules.d/
sudo udevadm control --reload && sudo udevadm trigger
# desenchufa y vuelve a enchufar el cable
```

Para cables serie basta con estar en el grupo `dialout` (`sudo usermod -aG dialout $USER`).

## Uso

```bash
.venv/bin/unitweb                    # abre http://127.0.0.1:8061
.venv/bin/unitweb --list             # lista cables detectados
.venv/bin/unitweb --device /dev/hidraw5 --model UT61C   # conecta al arrancar
.venv/bin/unitweb --device sim       # simulador, para probar sin multímetro
.venv/bin/unitweb --host 0.0.0.0     # accesible desde otros equipos de la red
```

Opciones también por variables de entorno: `UNITWEB_HOST`, `UNITWEB_PORT`, `UNITWEB_DB`,
`UNITWEB_DEVICE`, `UNITWEB_MODEL`.

Desde la web:

- Elige cable y modelo arriba y pulsa **Conectar**. Si desenchufas el cable, se reconecta solo.
- **Grabar**: guarda cada lectura (o una cada N segundos) en una sesión. Opcionalmente ignora las lecturas en HOLD.
- **Capturar valor**: guarda la lectura actual con una nota (útil para ir apuntando medidas de componentes).
- **Sesiones**: clic para ver la gráfica, estadísticas, renombrar, añadir notas, descargar CSV o borrar.

Los datos se guardan en SQLite (`unitweb.sqlite3` por defecto).

## API

| Método | Ruta | |
|---|---|---|
| GET | `/api/info` | modelos, dispositivos y estado |
| POST | `/api/connect` `{device, model}` / `/api/disconnect` | |
| POST | `/api/record/start` `{name, interval, skip_hold}` / `/api/record/stop` | |
| POST | `/api/snapshot` `{note}` · GET `/api/snapshots[/csv]` | |
| GET/PATCH/DELETE | `/api/sessions/{id}` · GET `/api/sessions/{id}/csv` | |
| WS | `/ws` | `hello` (estado + histórico), `reading`, `status`, `tick` |

## Desarrollo

```bash
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
```

Protocolos documentados en `unitweb/protocols.py`. Referencias: libsigrok
(`src/dmm/fs9922.c`, `es519xx.c`, `fs9721.c`, `src/hardware/uni-t-dmm/`), los datasheets de los chips y
[ljakob/unit_ut61eplus](https://github.com/ljakob/unit_ut61eplus) para la serie UT61+.

Pendiente: UT71x / UT804 (2400 7O1, 11 bytes) y UT372.
