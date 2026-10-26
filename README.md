# Smartstake logger

ESP32 Feather V2 firmware that reads printed ion-selective electrode (ISE) / reference electrode (RE) pairs, two DS18B20 temperature probes and the battery voltage, posts each reading to a Google Sheet, and a GitHub Pages site that plots the sheet live.

```
sensor_logger.ino          firmware (serial CSV + Google Sheets upload)
secrets.example.h          copy to secrets.h (gitignored) and fill in
google_apps_script/Code.gs Apps Script web app: POST appends rows, GET serves JSON
docs/                      GitHub Pages site
```

## 1. Google Sheet + Apps Script

1. Create a Google Sheet, open **Extensions → Apps Script**, and paste in `google_apps_script/Code.gs`.
2. Change `TOKEN` to a random string.
3. **Deploy → New deployment → Web app**, with *Execute as: Me* and *Who has access: Anyone*. Copy the URL ending in `/exec`.

After editing the script later, use **Deploy → Manage deployments → Edit → New version** so the same URL picks up the change.

## 2. Firmware

1. `cp secrets.example.h secrets.h` and fill in your WiFi network, the `/exec` URL and the token.
2. Build for **Adafruit Feather ESP32 V2** and upload. The first upload creates a `data` tab with a header row.

Networks with a login page (eduroam, guest WiFi) won't work; use a WPA2 password network or a phone hotspot.

## 3. Website

1. Put the `/exec` URL in `docs/config.js` (`dataUrl`).
2. Push the repo to GitHub, then **Settings → Pages → Deploy from a branch → `main` / `/docs`**.

### Nitrate calibration

The page plots the average nitrate of the checked channels over the last 6 hours, converting each pair with E [mV] = E0 + S·log10(C / mM), where E is the raw logger value (the sheet value × 1000).

**Reset plot** clears the plot and sets every channel to S = 60 mV/decade with E0 chosen so its latest reading is 20 ppm NO₃⁻-N. Channels, E0 and slope can be changed under **Calibration** (saved per browser); fixed values can also go in `docs/config.js`.

Until `dataUrl` is set the page shows simulated data. Add `?demo` to the page URL to show simulated data at any time.

Preview locally with `python3 -m http.server -d docs 8000` and open http://localhost:8000.

Note that the `/exec` URL is public in `config.js`: anyone can read the data, but uploads need the token.
