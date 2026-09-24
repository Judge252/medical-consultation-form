'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const schema = require('./schema');
const {
    buildEmailPayload,
    createApp,
    generatePdfBuffer,
    renderPdfHtml,
    sanitizeFilenamePart,
    validateAndNormalizeSubmission,
} = require('./server');

function createSampleData() {
    const data = Object.fromEntries(schema.fields.map((field) => [field.key, '']));

    return {
        ...data,
        patientName: 'נועה בדיקה',
        patientPhone: '052-1234567',
        address: 'רחוב הדוגמה 12, חיפה',
        patientId: '123456789',
        age: '42',
        gender: 'נקבה',
        referralReason: 'כאב בכתף ימין במשך שלושה שבועות.',
        backgroundDiseases: 'ללא מחלות רקע שצוינו.',
        regularMedications: 'תרופה לדוגמה פעם ביום.',
        occupationActivity: 'עבודה משרדית; הליכה שלוש פעמים בשבוע.',
        nutritionHabits: 'תזונה רגילה, ללא אלרגיות ידועות.',
        consciousness: 'בהכרה מלאה',
        temperature: '36.7',
        pulse: '72',
        bloodPressure: '118/76',
        observation: 'ללא ממצא חריג בהסתכלות.',
        bodyStructure: 'מבנה גוף בינוני.',
        weight: '68 ק״ג',
        skinCondition: 'עור שמור.',
        palpation: 'רגישות מקומית קלה.',
        vasPainScore: '6',
        jointExamination: 'טווח תנועה מוגבל קלות בהרמה.',
        muscleExamination: 'כוח שמור ברוב קבוצות השרירים.',
        neurologicalExamination: 'בדיקה מוטורית וסנסורית ללא ממצא חריג.',
        balanceAndFalls: 'שיווי משקל תקין; ללא נפילות לאחרונה.',
        specialTests: 'צילום רנטגן; נשקלת בדיקת CT או MRI לפי הצורך.',
        imagingResults: 'ממצא דמה תקין לצורך בדיקה טכנית בלבד.',
        bloodTests: 'בדיקות דמה ללא חסרים או חריגות.',
        consultationSummary: 'הושלם ייעוץ ובדיקה קלינית.',
        diagnosis: 'אבחנת דמה לצורך בדיקת המערכת בלבד.',
        treatmentPlan: 'תכנית דמה לצורך בדיקת יצירת המסמך.',
        doctorName: 'ד״ר ישראל בדיקה',
        licenseNumber: '123456',
        doctorSignature: 'ישראל בדיקה',
        examinationDate: '2026-08-25',
    };
}

function createSubmissionBody(submissionId, formData = createSampleData()) {
    return { submissionId, formData };
}

async function listen(app) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
        server.on('error', reject);
    });
}

async function close(server) {
    if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
    }
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('medical consultation application', async (t) => {
    const sampleData = createSampleData();

    await t.test('normalizes and validates the shared schema', () => {
        const result = validateAndNormalizeSubmission(createSubmissionBody('00000000-0000-4000-8000-000000000001', sampleData));
        assert.equal(result.valid, true);
        assert.equal(result.data.vasPainScore, '6');
        assert.deepEqual(Object.keys(result.data), schema.fields.map((field) => field.key));

        const invalidResult = validateAndNormalizeSubmission(createSubmissionBody(
            '00000000-0000-4000-8000-000000000002',
            { ...sampleData, vasPainScore: '11' },
        ));
        assert.equal(invalidResult.valid, false);
        assert.ok(invalidResult.errors.some((error) => error.field === 'vasPainScore'));
    });

    await t.test('enforces all mandatory patient details (name, phone, address, id, age, gender)', () => {
        const mandatoryFields = ['patientName', 'patientPhone', 'address', 'patientId', 'age', 'gender'];

        for (const fieldKey of mandatoryFields) {
            const dataMissingField = { ...sampleData, [fieldKey]: '' };
            const validation = validateAndNormalizeSubmission(createSubmissionBody(
                `00000000-0000-4000-8000-missing-${fieldKey.slice(0, 8)}`,
                dataMissingField,
            ));
            assert.equal(validation.valid, false, `Expected validation to fail when ${fieldKey} is missing`);
            assert.ok(validation.errors.some((err) => err.field === fieldKey), `Error for ${fieldKey} should be present`);
        }

        // Only mandatory patient details provided, optional fields empty
        const onlyMandatoryData = Object.fromEntries(schema.fields.map((field) => [field.key, '']));
        for (const fieldKey of mandatoryFields) {
            onlyMandatoryData[fieldKey] = sampleData[fieldKey];
        }
        const mandatoryValidation = validateAndNormalizeSubmission(createSubmissionBody(
            '00000000-0000-4000-8000-mandatory-only',
            onlyMandatoryData,
        ));
        assert.equal(mandatoryValidation.valid, true, 'Validation should pass when all required patient details are present');
    });

    await t.test('escapes submitted values and renders every field in the PDF template', () => {
        const html = renderPdfHtml({ ...sampleData, referralReason: '<script>alert(1)</script>' });
        assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
        assert.ok(!html.includes('<script>alert(1)</script>'));

        for (const field of schema.fields) {
            assert.ok(html.includes(field.label), `PDF label missing: ${field.key}`);
        }
    });

    let pdfBuffer;
    await t.test('generates a real Hebrew A4 PDF in memory', async () => {
        pdfBuffer = await generatePdfBuffer(sampleData);
        assert.ok(Buffer.isBuffer(pdfBuffer));
        assert.ok(pdfBuffer.length > 20000);
        assert.equal(pdfBuffer.subarray(0, 4).toString('ascii'), '%PDF');

        if (process.env.QA_PDF_PATH) {
            const outputPath = path.resolve(process.env.QA_PDF_PATH);
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, pdfBuffer);
        }
    });

    await t.test('serves the frontend, rejects invalid data, and sends once through a mock transport', async () => {
        const sentMessages = [];
        const app = createApp({
            emailSender: async (payload) => {
                sentMessages.push(payload);
                return { data: { id: 'mock-message-id' }, error: null };
            },
            mailConfig: { from: 'forms@example.test', to: 'clinic@example.test' },
            pdfFactory: async () => pdfBuffer,
            env: {},
        });
        const server = await listen(app);
        const address = server.address();
        const baseUrl = `http://127.0.0.1:${address.port}`;

        try {
            const healthResponse = await fetch(`${baseUrl}/health`);
            assert.equal(healthResponse.status, 200);
            assert.equal((await healthResponse.json()).status, 'ok');

            for (const resource of ['/', '/style.css', '/schema.js', '/app.js', '/assets/theclinic-logo.png']) {
                const response = await fetch(`${baseUrl}${resource}`);
                assert.equal(response.status, 200, `Failed to serve ${resource}`);
            }

            // Submitting empty body fails
            const requiredResponse = await fetch(`${baseUrl}/submit-form`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(createSubmissionBody('00000000-0000-4000-8000-000000000003', {})),
            });
            assert.equal(requiredResponse.status, 400);
            assert.equal((await requiredResponse.json()).code, 'VALIDATION_ERROR');

            // Submitting with missing address fails
            const missingAddressResponse = await fetch(`${baseUrl}/submit-form`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(createSubmissionBody(
                    '00000000-0000-4000-8000-00000000000a',
                    { ...sampleData, address: '' },
                )),
            });
            assert.equal(missingAddressResponse.status, 400);
            assert.equal((await missingAddressResponse.json()).code, 'VALIDATION_ERROR');

            // Submitting with missing patient ID fails
            const missingIdResponse = await fetch(`${baseUrl}/submit-form`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(createSubmissionBody(
                    '00000000-0000-4000-8000-00000000000b',
                    { ...sampleData, patientId: '' },
                )),
            });
            assert.equal(missingIdResponse.status, 400);
            assert.equal((await missingIdResponse.json()).code, 'VALIDATION_ERROR');

            // Submitting with missing age fails
            const missingAgeResponse = await fetch(`${baseUrl}/submit-form`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(createSubmissionBody(
                    '00000000-0000-4000-8000-00000000000c',
                    { ...sampleData, age: '' },
                )),
            });
            assert.equal(missingAgeResponse.status, 400);
            assert.equal((await missingAgeResponse.json()).code, 'VALIDATION_ERROR');

            // Submitting with missing gender fails
            const missingGenderResponse = await fetch(`${baseUrl}/submit-form`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(createSubmissionBody(
                    '00000000-0000-4000-8000-00000000000d',
                    { ...sampleData, gender: '' },
                )),
            });
            assert.equal(missingGenderResponse.status, 400);
            assert.equal((await missingGenderResponse.json()).code, 'VALIDATION_ERROR');

            const invalidVasResponse = await fetch(`${baseUrl}/submit-form`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(createSubmissionBody(
                    '00000000-0000-4000-8000-000000000004',
                    { ...sampleData, vasPainScore: '-1' },
                )),
            });
            assert.equal(invalidVasResponse.status, 400);

            const submissionId = '00000000-0000-4000-8000-000000000005';
            const successResponse = await fetch(`${baseUrl}/submit-form`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(createSubmissionBody(submissionId, sampleData)),
            });
            assert.equal(successResponse.status, 200);
            assert.equal((await successResponse.json()).status, 'success');
            assert.equal(sentMessages.length, 1);
            assert.match(sentMessages[0].subject, /טופס ייעוץ ובדיקה רפואית/);
            assert.ok(sentMessages[0].html.includes(sampleData.patientName));
            assert.ok(sentMessages[0].html.includes(sampleData.patientPhone));
            assert.ok(!sentMessages[0].html.includes(sampleData.diagnosis));
            assert.ok(sentMessages[0].attachments[0].filename.startsWith('medical-consultation-'));
            assert.equal(Buffer.from(sentMessages[0].attachments[0].content, 'base64').subarray(0, 4).toString('ascii'), '%PDF');

            const duplicateResponse = await fetch(`${baseUrl}/submit-form`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(createSubmissionBody(submissionId, sampleData)),
            });
            const duplicateBody = await duplicateResponse.json();
            assert.equal(duplicateResponse.status, 200);
            assert.equal(duplicateBody.duplicate, true);
            assert.equal(sentMessages.length, 1);

            const malformedResponse = await fetch(`${baseUrl}/submit-form`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{not valid json',
            });
            assert.equal(malformedResponse.status, 400);
            assert.equal((await malformedResponse.json()).code, 'INVALID_JSON');
        } finally {
            await close(server);
        }
    });

    await t.test('uses a Unicode-safe filename and minimal email body', () => {
        assert.equal(sanitizeFilenamePart(' נועה / בדיקה '), 'נועה-בדיקה');
        const payload = buildEmailPayload(sampleData, pdfBuffer, { from: 'a@example.test', to: 'b@example.test' });
        assert.equal(payload.attachments.length, 1);
        assert.ok(payload.attachments[0].filename.endsWith('.pdf'));
        assert.ok(!payload.html.includes(sampleData.treatmentPlan));
    });
});
