'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const puppeteer = require('puppeteer');
const { Resend } = require('resend');
const schema = require('./schema');

const ROOT_DIR = __dirname;
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');
const FONT_DIR = path.join(ASSETS_DIR, 'fonts');
const DEFAULT_PORT = 3000;
const JSON_LIMIT = '256kb';
const EMAIL_TIMEOUT_MS = 20000;
const SUBMISSION_TTL_MS = 15 * 60 * 1000;

const clinic = Object.freeze({
    name: 'הקליניקה – מרכז רופאי אורתופדי ונוירולוגי',
    branchOne: "סניף טורעאן, רח' אבו בכר 13",
    branchTwo: 'סניף רמלה, ד״ר סאלק 25',
    phoneOne: '052-6020026',
    phoneTwo: '04-6034691',
    displayEmail: 'The_clinic_t@gmail.com',
    formTitle: 'טופס ייעוץ ובדיקה רפואית',
    privacyNotice: 'המסמך מכיל מידע מוגן על-פי חוק הגנת הפרטיות',
});

let embeddedAssetCache = null;

class OperationalError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'OperationalError';
        this.code = code;
    }
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function normalizeText(value, preserveLines) {
    const cleaned = String(value ?? '')
        .normalize('NFC')
        .replace(/\r\n?/g, '\n')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim();

    return preserveLines ? cleaned : cleaned.replace(/\s+/g, ' ');
}

function codePointLength(value) {
    return Array.from(value).length;
}

function isValidIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

function validationMessage(field, reason) {
    if (reason === 'required') {
        return `יש למלא את השדה ${field.label}.`;
    }

    if (reason === 'length') {
        return `השדה ${field.label} ארוך מדי.`;
    }

    if (field.key === 'patientPhone') {
        return 'יש להזין מספר טלפון תקין.';
    }

    if (field.key === 'patientId') {
        return 'יש להזין מספר זהות הכולל 5 עד 12 ספרות.';
    }

    if (field.key === 'age') {
        return 'יש להזין גיל שלם בין 0 ל-130.';
    }

    if (field.key === 'vasPainScore') {
        return 'יש להזין ציון כאב שלם בין 0 ל-10.';
    }

    if (field.type === 'date') {
        return `יש להזין תאריך תקין בשדה ${field.label}.`;
    }

    return `הערך בשדה ${field.label} אינו תקין.`;
}

function validateAndNormalizeSubmission(body) {
    const errors = [];

    if (!isPlainObject(body)) {
        return {
            valid: false,
            errors: [{ field: null, message: 'גוף הבקשה אינו תקין.' }],
        };
    }

    const allowedTopLevelKeys = new Set(['submissionId', 'formData']);
    for (const key of Object.keys(body)) {
        if (!allowedTopLevelKeys.has(key)) {
            errors.push({ field: key, message: 'הבקשה מכילה שדה לא מוכר.' });
        }
    }

    const submissionId = normalizeText(body.submissionId, false);
    if (!/^[A-Za-z0-9-]{16,100}$/.test(submissionId)) {
        errors.push({ field: 'submissionId', message: 'מזהה השליחה אינו תקין.' });
    }

    if (!isPlainObject(body.formData)) {
        errors.push({ field: 'formData', message: 'נתוני הטופס אינם תקינים.' });
        return { valid: false, errors };
    }

    for (const key of Object.keys(body.formData)) {
        if (!schema.fieldMap[key]) {
            errors.push({ field: key, message: 'הטופס מכיל שדה לא מוכר.' });
        }
    }

    const normalizedData = {};

    for (const field of schema.fields) {
        const rawValue = body.formData[field.key];

        if (rawValue === undefined || rawValue === null || rawValue === '') {
            normalizedData[field.key] = '';
            if (field.required) {
                errors.push({ field: field.key, message: validationMessage(field, 'required') });
            }
            continue;
        }

        if (field.type === 'number') {
            if ((typeof rawValue !== 'string' && typeof rawValue !== 'number') || !String(rawValue).trim()) {
                errors.push({ field: field.key, message: validationMessage(field, 'type') });
                continue;
            }

            const numberValue = Number(rawValue);
            if (!Number.isInteger(numberValue) || numberValue < field.min || numberValue > field.max) {
                errors.push({ field: field.key, message: validationMessage(field, 'range') });
                continue;
            }

            normalizedData[field.key] = String(numberValue);
            continue;
        }

        if (typeof rawValue !== 'string') {
            errors.push({ field: field.key, message: validationMessage(field, 'type') });
            continue;
        }

        const value = normalizeText(rawValue, field.type === 'textarea');

        if (field.required && !value) {
            errors.push({ field: field.key, message: validationMessage(field, 'required') });
            normalizedData[field.key] = '';
            continue;
        }

        if (codePointLength(value) > field.maxLength) {
            errors.push({ field: field.key, message: validationMessage(field, 'length') });
            continue;
        }

        if (field.type === 'enum' && value && !field.values.includes(value)) {
            errors.push({ field: field.key, message: validationMessage(field, 'enum') });
            continue;
        }

        if (field.validation === 'phone' && value && !/^[+\d][\d\s().-]{5,22}\d$/.test(value)) {
            errors.push({ field: field.key, message: validationMessage(field, 'format') });
            continue;
        }

        if (field.validation === 'identity' && value && !/^\d{5,12}$/.test(value)) {
            errors.push({ field: field.key, message: validationMessage(field, 'format') });
            continue;
        }

        if (field.type === 'date' && value && !isValidIsoDate(value)) {
            errors.push({ field: field.key, message: validationMessage(field, 'format') });
            continue;
        }

        normalizedData[field.key] = value;
    }

    return {
        valid: errors.length === 0,
        submissionId,
        data: normalizedData,
        errors,
    };
}

function fileToDataUrl(filePath, mimeType) {
    return `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function getEmbeddedAssets() {
    if (embeddedAssetCache) {
        return embeddedAssetCache;
    }

    const fontSources = {};
    for (const weight of [400, 600, 700]) {
        fontSources[weight] = {
            hebrew: fileToDataUrl(path.join(FONT_DIR, `heebo-hebrew-${weight}-normal.woff2`), 'font/woff2'),
            latin: fileToDataUrl(path.join(FONT_DIR, `heebo-latin-${weight}-normal.woff2`), 'font/woff2'),
        };
    }

    embeddedAssetCache = Object.freeze({
        fontSources,
        logo: fileToDataUrl(path.join(ASSETS_DIR, 'theclinic-logo.png'), 'image/png'),
    });

    return embeddedAssetCache;
}

function renderEmbeddedFontCss(fontSources) {
    return [400, 600, 700].map((weight) => `
        @font-face {
            font-family: "Heebo Embedded";
            src: url("${fontSources[weight].hebrew}") format("woff2");
            font-style: normal;
            font-weight: ${weight};
            font-display: block;
            unicode-range: U+0307-0308, U+0590-05FF, U+200C-2010, U+20AA, U+25CC, U+FB1D-FB4F;
        }
        @font-face {
            font-family: "Heebo Embedded";
            src: url("${fontSources[weight].latin}") format("woff2");
            font-style: normal;
            font-weight: ${weight};
            font-display: block;
            unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
        }
    `).join('\n');
}

function renderPdfField(field, value) {
    const displayValue = value === '' || value === undefined || value === null ? 'לא צוין' : String(value);
    const direction = field.direction === 'ltr' || field.type === 'number' || field.type === 'date' ? 'ltr' : 'auto';
    const classes = ['pdf-field', field.wide ? 'pdf-field-wide' : '', displayValue === 'לא צוין' ? 'pdf-field-empty' : '']
        .filter(Boolean)
        .join(' ');

    return `
        <div class="${classes}">
            <dt>${escapeHtml(field.label)}</dt>
            <dd dir="${direction}">${escapeHtml(displayValue)}</dd>
        </div>
    `;
}

function renderPdfSection(section, data) {
    return `
        <section class="pdf-section pdf-section-${escapeHtml(section.id)}">
            <h2>${escapeHtml(section.title)}</h2>
            <dl class="pdf-grid">
                ${section.fields.map((field) => renderPdfField(field, data[field.key])).join('')}
            </dl>
        </section>
    `;
}

function renderPdfHtml(formData) {
    const assets = getEmbeddedAssets();
    const fontCss = renderEmbeddedFontCss(assets.fontSources);

    return `<!doctype html>
<html lang="he" dir="rtl">
<head>
    <meta charset="utf-8">
    <title>${escapeHtml(clinic.formTitle)}</title>
    <style>
        ${fontCss}

        @page {
            size: A4;
            margin: 12mm 11mm 18mm;
        }

        * { box-sizing: border-box; }

        html,
        body {
            margin: 0;
            padding: 0;
            direction: rtl;
            color: #172033;
            background: #ffffff;
            font-family: "Heebo Embedded", Arial, sans-serif;
            font-size: 9.7pt;
            line-height: 1.4;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }

        .pdf-header {
            display: grid;
            grid-template-columns: 1fr auto;
            align-items: center;
            justify-content: space-between;
            gap: 5mm;
            margin-bottom: 4mm;
            padding: 4mm 5mm;
            border: 1px solid #e2e8f0;
            border-top: 3px solid #1e3a8a;
            border-radius: 3.5mm;
            background: #f8fafc;
            break-inside: avoid;
        }

        .pdf-brand {
            min-width: 0;
        }

        .clinic-name {
            margin: 0 0 1mm;
            color: #1d6a42;
            font-size: 9.8pt;
            font-weight: 700;
            line-height: 1.25;
        }

        .pdf-brand h1 {
            margin: 0 0 2mm;
            color: #17375e;
            font-size: 16.5pt;
            font-weight: 700;
            line-height: 1.2;
            letter-spacing: -0.2px;
        }

        .contact-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 1.2mm;
            padding-top: 2mm;
            border-top: 1px solid #e2e8f0;
            color: #475569;
            font-size: 8pt;
            line-height: 1.35;
        }

        .contact-row {
            display: flex;
            align-items: center;
            gap: 2mm;
            white-space: nowrap;
        }

        .contact-sep {
            color: #94a3b8;
            font-size: 7pt;
            line-height: 1;
            user-select: none;
        }

        .pdf-logo-wrap {
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }

        .pdf-logo {
            display: block;
            width: 38mm;
            max-width: 42mm;
            height: auto;
            object-fit: contain;
        }

        .pdf-section {
            margin: 0 0 3mm;
            padding: 2.8mm 3.2mm 3.2mm;
            border: 1px solid #dce4ed;
            border-radius: 3.2mm;
            background: #ffffff;
        }

        .pdf-section:not(.pdf-section-physical-examination) {
            break-inside: avoid;
        }

        .pdf-section h2 {
            margin: 0 0 2mm;
            padding: 0 0 1.1mm;
            border-bottom: 1.5px solid #2aa993;
            color: #17375e;
            font-size: 12.5pt;
            line-height: 1.2;
            break-after: avoid;
        }

        .pdf-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 1.7mm;
            margin: 0;
        }

        .pdf-field {
            min-width: 0;
            padding: 1.7mm 2.2mm;
            border: 1px solid #e5eaf0;
            border-right: 2.5px solid #c99a37;
            border-radius: 2.3mm;
            background: #fbfcfe;
            break-inside: avoid;
        }

        .pdf-field-wide {
            grid-column: 1 / -1;
        }

        .pdf-field dt,
        .pdf-field dd {
            margin: 0;
        }

        .pdf-field dt {
            margin-bottom: 0.45mm;
            color: #546277;
            font-size: 7.9pt;
            font-weight: 700;
        }

        .pdf-field dd {
            min-height: 3.2mm;
            color: #111827;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            unicode-bidi: plaintext;
        }

        .pdf-field-empty dd {
            color: #8a96a7;
        }

        .signature-area {
            position: relative;
            min-height: 13mm;
            padding-top: 3mm;
            break-inside: avoid;
        }

        .signature-line {
            width: 65mm;
            max-width: 100%;
            margin-top: 5mm;
            border-bottom: 1px solid #374151;
        }

        .signature-caption {
            margin-top: 1mm;
            color: #667387;
            font-size: 8pt;
        }

    </style>
</head>
<body>
    <header class="pdf-header">
        <div class="pdf-brand">
            <p class="clinic-name">${escapeHtml(clinic.name)}</p>
            <h1>${escapeHtml(clinic.formTitle)}</h1>
            <div class="contact-grid">
                <div class="contact-row">
                    <span>${escapeHtml(clinic.branchOne)}</span>
                    <span class="contact-sep">•</span>
                    <span>${escapeHtml(clinic.branchTwo)}</span>
                </div>
                <div class="contact-row">
                    <span dir="ltr">${escapeHtml(clinic.phoneOne)} / ${escapeHtml(clinic.phoneTwo)}</span>
                    <span class="contact-sep">•</span>
                    <span dir="ltr">${escapeHtml(clinic.displayEmail)}</span>
                </div>
            </div>
        </div>
        <div class="pdf-logo-wrap">
            <img class="pdf-logo" src="${assets.logo}" alt="TheClinic Healthcare and Therapy">
        </div>
    </header>

    ${schema.sections.map((section) => renderPdfSection(section, formData)).join('')}

    <div class="signature-area">
        <div class="signature-line"></div>
        <div class="signature-caption">חתימת הרופא</div>
    </div>

</body>
</html>`;
}

function renderPdfFooterTemplate() {
    const { fontSources } = getEmbeddedAssets();

    return `
        <style>
            @font-face {
                font-family: "Heebo Footer";
                src: url("${fontSources[400].hebrew}") format("woff2");
                font-style: normal;
                font-weight: 400;
            }
            @font-face {
                font-family: "Heebo Footer";
                src: url("${fontSources[400].latin}") format("woff2");
                font-style: normal;
                font-weight: 400;
            }
        </style>
        <div dir="rtl" style="width:100%;margin:0 11mm;padding-top:2mm;border-top:1px solid #d5dee9;color:#516072;font-family:'Heebo Footer',Arial,sans-serif;font-size:8.3pt;text-align:center">
            ${escapeHtml(clinic.privacyNotice)}
        </div>
    `;
}

function resolveBrowserExecutablePath() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    let candidates = [];
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || '';
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        candidates = [
            path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ];
    } else if (process.platform === 'linux') {
        candidates = [
            '/usr/bin/google-chrome-stable',
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
        ];
    } else if (process.platform === 'darwin') {
        candidates = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ];
    }

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

async function generatePdfBuffer(formData) {
    const html = renderPdfHtml(formData);
    let browser;

    try {
        const launchOptions = {
            headless: true,
            timeout: 30000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
            ],
        };

        const executablePath = resolveBrowserExecutablePath();
        if (executablePath) {
            launchOptions.executablePath = executablePath;
        }

        browser = await puppeteer.launch(launchOptions);
        const page = await browser.newPage();
        page.setDefaultTimeout(20000);
        await page.setContent(html, { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: renderPdfFooterTemplate(),
        });

        return Buffer.from(pdfBuffer);
    } catch (error) {
        console.error('[pdf-generation] Failed to generate PDF buffer:', error.message);
        throw error;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

function sanitizeFilenamePart(value) {
    const sanitized = normalizeText(value, false)
        .normalize('NFKC')
        .replace(/[\\/:*?"<>|]/g, '')
        .replace(/[^\p{L}\p{N}\-_ ]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-_.]+|[-_.]+$/g, '');

    return Array.from(sanitized).slice(0, 60).join('') || 'patient';
}

function buildEmailPayload(formData, pdfBuffer, mailConfig) {
    const patientName = formData.patientName;
    const patientPhone = formData.patientPhone;
    const fileName = `medical-consultation-${sanitizeFilenamePart(patientName)}.pdf`;

    return {
        from: mailConfig.from,
        to: mailConfig.to,
        subject: `${clinic.formTitle} – ${patientName}`,
        html: `
            <div lang="he" dir="rtl" style="font-family:Arial,sans-serif;line-height:1.6;color:#172033">
                <h2 style="margin:0 0 12px">${escapeHtml(clinic.formTitle)}</h2>
                <p><strong>שם המטופל:</strong> ${escapeHtml(patientName)}</p>
                <p><strong>טלפון:</strong> <bdi dir="ltr">${escapeHtml(patientPhone)}</bdi></p>
                <p>קובץ ה-PDF המלא מצורף להודעה זו.</p>
            </div>
        `,
        attachments: [{
            filename: fileName,
            content: pdfBuffer.toString('base64'),
        }],
    };
}

function resolveMailTransport({ env, emailSender, mailConfig }) {
    if (typeof emailSender === 'function') {
        if (!mailConfig || !mailConfig.from || !mailConfig.to) {
            throw new OperationalError('EMAIL_CONFIGURATION_ERROR', 'Mock email configuration is incomplete');
        }

        return { send: emailSender, from: mailConfig.from, to: mailConfig.to };
    }

    const requiredVariables = ['RESEND_API_KEY', 'RESEND_FROM', 'RESEND_TO'];
    const missingVariables = requiredVariables.filter((name) => !normalizeText(env[name], false));

    if (missingVariables.length) {
        throw new OperationalError('EMAIL_CONFIGURATION_ERROR', `חסרים משתני סביבה לשליחת דוא״ל: ${missingVariables.join(', ')}`);
    }

    const resend = new Resend(env.RESEND_API_KEY);
    return {
        from: env.RESEND_FROM,
        to: env.RESEND_TO,
        send: (payload) => resend.emails.send(payload),
    };
}

function withTimeout(promise, timeoutMs) {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new OperationalError('EMAIL_TIMEOUT', 'שליחת הדוא״ל עברה את מגבלת הזמן (timeout)')), timeoutMs);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function logOperationalError(stage, error) {
    const errorType = error && error.name ? error.name : 'Error';
    const errorCode = error && error.code ? ` (${error.code})` : '';
    const errorMsg = error && error.message ? `: ${error.message}` : '';
    console.error(`[${stage}] ${errorType}${errorCode}${errorMsg}`);
    if (error && error.stack) {
        console.error(error.stack);
    }
}

function setSecurityHeaders(_req, res, next) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'");
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
}

function createApp(options = {}) {
    const app = express();
    const env = options.env || process.env;
    const pdfFactory = options.pdfFactory || generatePdfBuffer;
    const completedSubmissions = new Map();
    const activeSubmissions = new Set();

    app.disable('x-powered-by');
    app.use(setSecurityHeaders);
    app.use(express.json({ limit: JSON_LIMIT, strict: true, type: 'application/json' }));

    app.get('/health', (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ status: 'ok' });
    });

    app.get(['/', '/index.html'], (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(path.join(ROOT_DIR, 'index.html'));
    });

    for (const fileName of ['style.css', 'schema.js', 'app.js']) {
        app.get(`/${fileName}`, (_req, res) => {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
            res.sendFile(path.join(ROOT_DIR, fileName));
        });
    }

    app.use('/assets', express.static(ASSETS_DIR, {
        dotfiles: 'deny',
        fallthrough: false,
        index: false,
        maxAge: '1d',
    }));

    app.post('/submit-form', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const validation = validateAndNormalizeSubmission(req.body);

        if (!validation.valid) {
            return res.status(400).json({
                status: 'error',
                code: 'VALIDATION_ERROR',
                message: 'יש לבדוק את הנתונים ולנסות שוב.',
                errors: validation.errors,
            });
        }

        const now = Date.now();
        for (const [id, completedAt] of completedSubmissions) {
            if (now - completedAt > SUBMISSION_TTL_MS) {
                completedSubmissions.delete(id);
            }
        }

        if (completedSubmissions.has(validation.submissionId)) {
            return res.status(200).json({
                status: 'success',
                message: 'הטופס כבר נשלח בהצלחה.',
                duplicate: true,
            });
        }

        if (activeSubmissions.has(validation.submissionId)) {
            return res.status(409).json({
                status: 'error',
                code: 'SUBMISSION_IN_PROGRESS',
                message: 'השליחה כבר מתבצעת.',
            });
        }

        activeSubmissions.add(validation.submissionId);

        try {
            let transport;
            try {
                transport = resolveMailTransport({
                    env,
                    emailSender: options.emailSender,
                    mailConfig: options.mailConfig,
                });
            } catch (error) {
                logOperationalError('email-config', error);
                return res.status(503).json({
                    status: 'error',
                    code: 'EMAIL_CONFIGURATION_ERROR',
                    message: error.message || 'שירות השליחה אינו מוגדר כעת.',
                    detail: error.message,
                });
            }

            let pdfBuffer;
            try {
                pdfBuffer = await pdfFactory(validation.data);
                if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 1000) {
                    throw new OperationalError('INVALID_PDF', 'קובץ ה-PDF שנוצר אינו תקין');
                }
            } catch (error) {
                logOperationalError('pdf-generation', error);
                return res.status(500).json({
                    status: 'error',
                    code: 'PDF_GENERATION_FAILED',
                    message: 'יצירת קובץ ה-PDF לא הושלמה.',
                    detail: error.message,
                });
            }

            try {
                const emailPayload = buildEmailPayload(validation.data, pdfBuffer, transport);
                const result = await withTimeout(Promise.resolve(transport.send(emailPayload)), EMAIL_TIMEOUT_MS);

                if (result && result.error) {
                    const providerErrorMsg = result.error.message || JSON.stringify(result.error);
                    console.error('[email-delivery] Resend error:', providerErrorMsg);
                    throw new OperationalError('EMAIL_PROVIDER_ERROR', providerErrorMsg);
                }
            } catch (error) {
                logOperationalError('email-delivery', error);
                return res.status(502).json({
                    status: 'error',
                    code: 'EMAIL_DELIVERY_FAILED',
                    message: 'שליחת הטופס בדוא״ל לא הושלמה.',
                    detail: error.message,
                });
            }

            completedSubmissions.set(validation.submissionId, Date.now());
            return res.status(200).json({
                status: 'success',
                message: 'קובץ ה-PDF נוצר ונשלח בהצלחה.',
            });
        } finally {
            activeSubmissions.delete(validation.submissionId);
        }
    });

    app.use((error, _req, res, next) => {
        if (!error) {
            return next();
        }

        if (error.type === 'entity.too.large') {
            return res.status(413).json({
                status: 'error',
                code: 'PAYLOAD_TOO_LARGE',
                message: 'הבקשה גדולה מדי.',
            });
        }

        if (error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, 'body')) {
            return res.status(400).json({
                status: 'error',
                code: 'INVALID_JSON',
                message: 'הבקשה אינה תקינה.',
            });
        }

        if (error.status === 404) {
            return res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'הקובץ לא נמצא.' });
        }

        logOperationalError('request', error);
        return res.status(500).json({
            status: 'error',
            code: 'INTERNAL_ERROR',
            message: 'אירעה שגיאה פנימית.',
        });
    });

    app.use((_req, res) => {
        res.status(404).json({ status: 'error', code: 'NOT_FOUND', message: 'העמוד לא נמצא.' });
    });

    return app;
}

function startServer(port = Number(process.env.PORT) || DEFAULT_PORT) {
    const app = createApp();
    return app.listen(port, () => {
        console.log(`Medical consultation form server is running on port ${port}`);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = {
    buildEmailPayload,
    clinic,
    createApp,
    escapeHtml,
    generatePdfBuffer,
    renderPdfHtml,
    sanitizeFilenamePart,
    startServer,
    validateAndNormalizeSubmission,
};
