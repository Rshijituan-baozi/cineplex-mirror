import 'dotenv/config';
import express from 'express';
import http from 'http';
import https from 'https';
import { createCineplexProxy, createApiProxy, createMediaProxy, handleTicketing, handleConnect, tryApiCache } from './proxy.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

process.on('uncaughtException', (err) => { console.error('[FATAL]', err.message); });
process.on('unhandledRejection', (reason) => { console.error('[REJECT]', reason); });

const PORT = parseInt(process.env.PORT || '3000');
const app = express();

const apiProxy = createApiProxy();
const mediaProxy = createMediaProxy();
const mainProxy = createCineplexProxy(process.env.PUBLIC_HOST || `localhost:${PORT}`);

const MEDIA_PREFIXES = ['/cineplex-v2', '/Attachments', '/Central', '/modernization', '/Screenshot', '/Desktop', '/favicon-light', '/dark-favicon'];

// Global JSON body parser
app.use(express.json());

// Redirect /ticketing/tickets -> /tickets/
app.use('/ticketing/tickets', (req, res) => {
  const qs = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  res.redirect(301, '/tickets/' + qs);
});

// Tickets static page
app.use('/tickets', express.static(join(__dirname, '..', 'public', 'tickets')));
app.use('/giftcards', express.static(join(__dirname, '..', 'public', 'giftcards')));

// All requests go through main proxy below (after API/media/connect handlers)

// Connect proxy: /Account/CCWebConnect/* → connect.cineplex.com
app.use('/Account/CCWebConnect', handleConnect);

// Ticketing API
app.use((req, res, next) => {
  if (req.url.startsWith('/prod/ticketing')) {
    handleTicketing(req, res, next);
    return;
  }
  next();
});

// API proxy (excludes ticketing)
app.use((req, res, next) => {
  if (req.url.startsWith('/prod') && !req.url.startsWith('/prod/ticketing')) {
    if (tryApiCache(req, res)) return;
    apiProxy(req, res, next);
    return;
  }
  next();
});

// Redirect /_Incapsula_Resource → www.cineplex.com (Imperva bot challenge)
app.use('/_Incapsula_Resource', (req, res) => {
  return res.redirect(301, 'https://www.cineplex.com' + req.url);
});

// Fix _next/image URLs only (no redirects for _next/static or _next/data - they go through proxy)
app.use((req, res, next) => {
  if (req.url.startsWith('/_next/image')) {
    // Fix relative _next/image URLs → redirect to absolute origin, preserving all params
    const m = req.url.match(/url=(%2F[^&]+)(&.*)?$/);
    if (m) {
      try {
        const decoded = decodeURIComponent(m[1]);
        if (decoded.startsWith('/')) {
          const rest = m[2] || '';
          return res.redirect(301, 'https://www.cineplex.com/_next/image?url=' + encodeURIComponent('https://mediafiles.cineplex.com' + decoded) + rest);
        }
      } catch {}
    }
    return res.redirect(301, 'https://www.cineplex.com' + req.url);
  }
  next();
});

// Media proxy
app.use((req, res, next) => {
  if (MEDIA_PREFIXES.some(p => req.url.startsWith(p))) {
    mediaProxy(req, res, next);
    return;
  }
  next();
});

// Main proxy
app.use('/', mainProxy);

const server = http.createServer(app);
server.timeout = 120000;
server.keepAliveTimeout = 65000;

server.listen(PORT, '0.0.0.0', () => console.log(`[Cineplex Mirror] Port ${PORT}`));
