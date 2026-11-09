# ARGUS mount — ESP32-S3 firmware

Starter firmware for an alt-az pointing head that follows the ARGUS console: it tracks the
object selected on the globe, or wherever you look in **Sky view**.

> Status: written against the Arduino-ESP32 core 3.x API but **not yet run on hardware**.
> Bench-test servo directions and pulse limits before mounting a camera.

## Hardware

| Part | Notes |
|---|---|
| ESP32-S3 dev board | native USB (CDC) used for commands |
| 2 × 180° hobby servos on a pan/tilt bracket | pan = azimuth, tilt = elevation |
| 5–6 V supply for the servos (≥ 2 A) | **do not** power servos from the board's 3V3/5V pin; share ground with the ESP32 |
| (optional) camera on the tilt plate | the console predicts satellite streaks for its field of view |

Default pins: pan signal **GPIO 4**, tilt signal **GPIO 5** (change `PAN_PIN` / `TILT_PIN`).

**Full-sky coverage with 180° servos:** azimuths 0–180° use tilt 0–90°. For azimuths 180–360°
the pan turns to az − 180° and the tilt goes *past the zenith* (tilt = 180° − el). The tilt servo
therefore needs its full 0–180° travel.

## Build & flash (Arduino IDE)

1. Boards Manager → install **esp32 by Espressif** (3.x).
2. Board: **ESP32S3 Dev Module**, *USB CDC On Boot: Enabled*.
3. Open `argus_mount.ino`, adjust the pins and pulse widths (`*_MIN_US`, `*_MAX_US`) for your servos, and upload.
4. Optional Wi-Fi: install the **WebSockets** library (Markus Sattler), set `ENABLE_WIFI 1` and your SSID and password.
   The mount then answers at `ws://argus-mount.local:81/`. Use its IP address instead if mDNS doesn't resolve.

## Connect from the console

Open **Mount** in the left rail:

- **USB (Web Serial)** — Chrome or Edge; click *Connect* and choose the ESP32's serial port (115200 baud).
- **Wi-Fi (WebSocket)** — enter `ws://argus-mount.local:81/` and click *Connect*.
- Mode **Track selected** follows the selected satellite, asteroid or the Moon; **Follow view** mirrors the Sky-view camera.

The console applies elevation limits, refuses to point within the *Sun exclusion* angle (protects the camera),
waits at the horizon for targets that have not risen, and adds the *azimuth offset* before sending.

## Protocol

ASCII lines, `\n`-terminated, identical over USB and WebSocket.

| Direction | Message | Meaning |
|---|---|---|
| host → mount | `AZEL <az> <el> <azRate> <elRate>` | point at az (deg from true north + offset) / el (deg); rates in deg/s for feed-forward between packets |
| host → mount | `PARK` · `STOP` · `PING` | park at az 0 / el 90 · hold current position · liveness check |
| mount → host | `HELLO ARGUS-MOUNT 1.0` | on boot / WebSocket connect |
| mount → host | `POS <az> <el>` | actual pointing at 10 Hz (shown as "Actual" in the console) |
| mount → host | `PONG` · `OK …` · `ERR …` | replies |

The console streams `AZEL` at the configured rate (default 10 Hz). Between packets the firmware
extrapolates with the supplied rates and slews at most `MAX_SLEW_DPS` (default 60 °/s). It parks
automatically if no command arrives for 30 s.

You can test without the console from any serial monitor (115200 baud, newline line ending):

```
PING
AZEL 135 45
AZEL 270 30
PARK
```

## Calibration

1. Level the base and point the pan zero toward true north if you can (or measure the offset).
2. In the console select the **Moon** (or a bright planet/star in Sky view) → *Track with mount*.
3. Adjust **Azimuth offset** in Mount → *Limits & calibration* until the target is centred.
4. If a servo moves the wrong way, flip `PAN_INVERT` / `TILT_INVERT`.

## Going further

- **Steppers** for continuous azimuth (no flip) and smoother tracking: replace `servoWrite` with a
  stepper driver (e.g. TMC2209 + AccelStepper) and use the `azRate`/`elRate` feed-forward as the target velocity.
- **Closed loop**: add an IMU/magnetometer or absolute encoders and report the measured angles in `POS`.
