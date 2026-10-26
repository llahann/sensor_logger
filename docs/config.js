// Site settings. dataUrl is the Apps Script web app URL (ends in /exec);
// add ?demo to the page URL to show simulated data.
window.SMARTSTAKE_CONFIG = {
  dataUrl: "https://script.google.com/macros/s/AKfycbzKRGDYE2wYDGtyi_WvUvvjKkfLjQ2iN4v6C9d8QEEThCNwxhDFvHNULkkh4HrUbH1-Tw/exec",
  refreshSeconds: 20,
  title: "Smartstake",

  // Optional fixed calibration per pair, E [mV] = e0 + slope * log10(C / mM).
  // Pairs left out are set by Reset plot (60 mV/decade, 20 ppm NO3-N now).
  calibration: {
    analyte: "Nitrate",
    unit: "ppm N",            // "ppm N", "ppm NO3" or "mM"
    pairs: {},
  },
};
