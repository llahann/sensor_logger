// Site settings. Paste the Apps Script web app URL (ends in /exec) into dataUrl.
// While it still contains XXXXXXXX the page shows simulated data; add ?demo to
// the page URL to force simulated data later.
window.SMARTSTAKE_CONFIG = {
  dataUrl: "https://script.google.com/macros/s/AKfycbzKRGDYE2wYDGtyi_WvUvvjKkfLjQ2iN4v6C9d8QEEThCNwxhDFvHNULkkh4HrUbH1-Tw/exec",
  refreshSeconds: 60,
  title: "Smartstake live data",
  defaultView: "potential",   // "potential" or "concentration"

  // Nernstian calibration per electrode pair, fit against the raw logger
  // reading in mV (the sheet value x 1000), so any readout offset is absorbed
  // into e0:   E [mV] = e0 + slope * log10(C / mM)
  // Nitrate slopes are negative, about -55 to -59 mV/decade. Pairs left out
  // show as uncalibrated. Values can also be edited on the page and copied back here.
  calibration: {
    analyte: "Nitrate",
    unit: "mM",               // "mM", "mg/L NO3" or "mg/L N"
    pairs: {
      // s1_re1_ise1: { e0: 1430.0, slope: -56.0 },
    },
  },
};
