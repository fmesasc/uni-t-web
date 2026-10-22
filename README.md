# UNI-T Web

Lee multímetros **UNI-T** (UT61C y compatibles) desde el navegador, sin instalar el software de
Windows ni nada más. Todo se ejecuta en tu navegador: el cable USB se lee con **WebHID** o
**Web Serial**, y los datos se guardan en el propio navegador (IndexedDB). No hay servidor.

**▶ Úsalo aquí: https://fmesasc.github.io/uni-t-web/** · [demo con simulador](https://fmesasc.github.io/uni-t-web/?demo)

Necesita **Chrome, Edge, Chromium, Brave u Opera** en escritorio (Linux, Windows, macOS o ChromeOS).
Firefox y Safari no tienen WebHID ni Web Serial.

## Qué hace

- **Pantalla** como la del multímetro: modo, indicadores (AUTO, HOLD, REL, MAX, MIN, BAT) y barra.
- **Estadísticas** en vivo: mínimo, máximo, media, desviación típica, pico a pico y lecturas por segundo.
- **Gráfica en vivo** con ventanas de 30 s a 1 h. Arrastra para ampliar y haz doble clic para volver.
- **Exportar** la gráfica como PNG (con título y estadísticas) y los datos en CSV o JSON, o copiarlos
  como tabla con coma decimal para pegarlos en una hoja de cálculo.
- **Grabar sesiones**: cada lectura o una cada N segundos, con parada automática tras un tiempo y la
  opción de ignorar lecturas en HOLD. Cada sesión tiene su gráfica, estadísticas de la zona visible,
  notas y exportación. En corriente DC calcula también la **carga** (mAh/Ah).
- **Capturas** sueltas de la lectura actual con una nota.
- **± Invertir** el signo si conectaste las puntas al revés. Afecta a la tensión y la corriente DC,
  y también a lo que se graba.
- **Δ REL**: fija una referencia y muestra la diferencia, en valor y en porcentaje.
- **Alarmas** por mínimo y máximo: pitido, notificación del navegador y opción de parar la grabación.
- **Clasificar componentes**: valor nominal ± tolerancia → DENTRO/FUERA. Con la captura automática,
  cada pieza se guarda sola cuando la lectura se estabiliza.
- **Voz**: lee el valor en voz alta cuando se estabiliza, útil cuando tienes las manos ocupadas con las puntas.
- **Pantalla completa** con números enormes, para leerlos desde lejos.
- **Copia de seguridad** de todo en un JSON, y restauración desde él.
- **Reconexión automática** al volver a enchufar el cable, y aviso si el multímetro no envía datos.
- Atajos de teclado: `espacio` captura · `R` REL · `I` invertir · `V` voz · `F` pantalla completa · `P` pausa.

## Modelos

| Modelo | Protocolo | Conexión | Estado |
|---|---|---|---|
| UT61B, **UT61C**, UT61D | FS9922-DMM4, 2400 8N1 | cable UT-D04 (USB) o UT-D02 (RS-232) | protocolo probado con UT61C |
| UT61E | ES51922, 19200 7O1 | UT-D04 / UT-D02 | sin probar con hardware |
| UT60A, UT60E | FS9721, 2400 8N1 | UT-D04 / UT-D02 | sin probar con hardware |
| UT61B+, UT61D+, UT61E+, UT161B/D/E | protocolo `AB CD` por petición, 9600 | USB con CP2110 | experimental |

Cables USB reconocidos: `1a86:e008` (WCH CH9325), `04fa:2490` (Hoitek HE2325U) y `10c4:ea80` (CP2110).

> **Activa el envío de datos en el multímetro.** En el UT61C, mantén pulsado `REL` hasta que aparezca
> `RS232` en la pantalla. Si la web dice *"Sin datos"*, casi siempre es esto.

## Linux: permiso para el cable (una sola vez)

Por defecto, solo root puede abrir los dispositivos `hidraw`. Instala la regla udev:

```bash
sudo curl -o /etc/udev/rules.d/70-uni-t.rules \
  https://raw.githubusercontent.com/fmesasc/uni-t-web/main/udev/70-uni-t.rules
sudo udevadm control --reload && sudo udevadm trigger
```

Después desenchufa y vuelve a enchufar el cable. Para cables serie basta con estar en el grupo
`dialout`. Si usas Chromium instalado como *snap*, puede que además necesites
`sudo snap connect chromium:raw-usb`.

En Windows y macOS no hace falta nada.

## Usarlo sin internet

Es una web estática. Clona el repositorio y sírvela en local, porque WebHID exige `https` o `localhost`:

```bash
git clone https://github.com/fmesasc/uni-t-web && cd uni-t-web
python3 -m http.server 8000      # y abre http://localhost:8000
```

## Desarrollo

No hay dependencias ni proceso de build: HTML, CSS y JavaScript sin módulos.

```
index.html        página
css/style.css
js/protocols.js   parsers FS9922, ES51922, FS9721 y UT61+ (también se usan desde Node)
js/drivers.js     WebHID (UT-D04, CP2110), Web Serial y simulador
js/db.js          almacenamiento en IndexedDB
js/app.js         interfaz
tests/            tests de protocolos (node o navegador) y test de extremo a extremo
```

```bash
node tests/protocols.test.js                   # o abre tests/index.html
# y con la web servida en local: http://localhost:8000/tests/e2e.html
```

Referencias de los protocolos: [libsigrok](https://github.com/sigrokproject/libsigrok)
(`src/dmm/fs9922.c`, `es519xx.c`, `fs9721.c`, `src/hardware/uni-t-dmm/`), los datasheets de los
chips, el software oficial de UNI-T (UT61C_D V3.03 / UT61E V4.01) y
[ljakob/unit_ut61eplus](https://github.com/ljakob/unit_ut61eplus) para la serie UT61+.

Pendiente: UT71x / UT804 (2400 7O1, 11 bytes) y UT372.

## Licencia

MIT
