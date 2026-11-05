import React, { useMemo } from 'react';
import { Platform } from 'react-native';
import { WebView } from 'react-native-webview';

/**
 * In-app PDF preview (§4.3.2) without native PDF modules.
 * iOS: WKWebView renders PDF data natively (no share/download controls).
 * Android: WebView cannot render PDFs, so pages are drawn with pdf.js.
 * The decrypted bytes never touch the file system; they are passed in memory as a data URI.
 * TODO: bundle pdf.js with the app instead of loading it from cdnjs.
 */
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38';

export function PdfView({ base64 }: { base64: string }) {
  const html = useMemo(
    () => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5">
<style>html,body{margin:0;background:#222}canvas{display:block;width:100%;margin:0 0 8px}</style></head><body>
<script type="module">
import * as pdfjs from '${PDFJS}/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = '${PDFJS}/pdf.worker.min.mjs';
const bin = atob('${base64}');
const bytes = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale: 2 });
  const c = document.createElement('canvas');
  c.width = vp.width; c.height = vp.height;
  document.body.appendChild(c);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
}
</script></body></html>`,
    [base64],
  );

  if (Platform.OS === 'ios') {
    return <WebView source={{ uri: `data:application/pdf;base64,${base64}` }} originWhitelist={['data:*']} style={{ flex: 1, backgroundColor: '#222' }} />;
  }
  return (
    <WebView
      source={{ html, baseUrl: 'https://localhost/' }}
      originWhitelist={['*']}
      javaScriptEnabled
      allowFileAccess={false}
      setSupportMultipleWindows={false}
      style={{ flex: 1, backgroundColor: '#222' }}
    />
  );
}
