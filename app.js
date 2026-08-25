(function initMedicalConsultationForm() {
    'use strict';

    const schema = window.MEDICAL_FORM_SCHEMA;
    const form = document.getElementById('medical-consultation-form');
    const submitButton = document.getElementById('submit-button');
    const buttonLabel = submitButton.querySelector('.button-label');
    const formStatus = document.getElementById('form-status');
    const messageDialog = document.getElementById('message-dialog');
    const dialogTitle = document.getElementById('dialog-title');
    const dialogDescription = document.getElementById('dialog-description');
    const dialogClose = document.getElementById('dialog-close');

    const defaultButtonText = 'יצירה ושליחה';
    const processingButtonText = 'יוצר ושולח...';
    const generalFailureText = 'אירעה שגיאה בשליחת הטופס. הנתונים שמילאת נשמרו, וניתן לנסות שוב.';
    const requestTimeoutMs = 60000;

    let isSubmitting = false;
    let currentSubmissionId = null;

    if (!schema || !form) {
        throw new Error('Form initialization failed');
    }

    function normalizeClientValue(value) {
        return String(value ?? '').normalize('NFC').trim();
    }

    function setFieldValidationMessage(input) {
        const value = normalizeClientValue(input.value);
        input.setCustomValidity('');

        if (input.id === 'patientName' && value && value.length < 2) {
            input.setCustomValidity('יש להזין שם מטופל מלא.');
        }

        if (input.id === 'patientPhone' && value && !/^[+\d][\d\s().-]{5,22}\d$/.test(value)) {
            input.setCustomValidity('יש להזין מספר טלפון תקין.');
        }

        if (input.id === 'patientId' && value && !/^\d{5,12}$/.test(value)) {
            input.setCustomValidity('יש להזין 5 עד 12 ספרות בלבד.');
        }

        if (input.id === 'age' && value && (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 130)) {
            input.setCustomValidity('יש להזין גיל שלם בין 0 ל-130.');
        }

        if (input.id === 'vasPainScore' && value && (!Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 10)) {
            input.setCustomValidity('יש להזין ציון כאב שלם בין 0 ל-10.');
        }

        input.setAttribute('aria-invalid', input.validity.valid ? 'false' : 'true');
    }

    function validateAllFields() {
        for (const field of schema.fields) {
            const input = document.getElementById(field.key);
            if (input) {
                setFieldValidationMessage(input);
            }
        }

        return form.checkValidity();
    }

    function collectFormData() {
        return Object.fromEntries(schema.fields.map((field) => {
            const input = document.getElementById(field.key);
            return [field.key, normalizeClientValue(input ? input.value : '')];
        }));
    }

    function createSubmissionId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') {
            return window.crypto.randomUUID();
        }

        const randomPart = Math.random().toString(16).slice(2);
        return `${Date.now().toString(16)}-${randomPart}-${randomPart.slice(0, 8)}`;
    }

    function setLoadingState(loading) {
        isSubmitting = loading;
        submitButton.disabled = loading;
        submitButton.classList.toggle('is-loading', loading);
        submitButton.setAttribute('aria-busy', loading ? 'true' : 'false');
        buttonLabel.textContent = loading ? processingButtonText : defaultButtonText;
        submitButton.dataset.label = loading ? processingButtonText : defaultButtonText;
        formStatus.textContent = loading ? processingButtonText : '';
    }

    function showMessage({ title, description, type = 'success', closeText = 'סגירה' }) {
        dialogTitle.textContent = title;
        dialogDescription.textContent = description;
        dialogClose.textContent = closeText;
        messageDialog.classList.toggle('is-error', type === 'error');

        if (typeof messageDialog.showModal !== 'function') {
            window.alert(`${title}\n\n${description}`);
            return Promise.resolve();
        }

        if (messageDialog.open) {
            messageDialog.close();
        }

        messageDialog.showModal();

        return new Promise((resolve) => {
            const closeDialog = () => messageDialog.close();
            const finish = () => {
                dialogClose.removeEventListener('click', closeDialog);
                resolve();
            };

            dialogClose.addEventListener('click', closeDialog);
            messageDialog.addEventListener('close', finish, { once: true });
        });
    }

    async function parseJsonResponse(response) {
        const rawBody = await response.text();

        if (!rawBody) {
            throw new Error('EMPTY_RESPONSE');
        }

        try {
            return JSON.parse(rawBody);
        } catch {
            throw new Error('INVALID_JSON_RESPONSE');
        }
    }

    async function submitForm() {
        if (isSubmitting) {
            return;
        }

        form.classList.add('was-validated');
        const valid = validateAllFields();

        if (!valid) {
            const firstInvalidField = form.querySelector(':invalid');
            formStatus.textContent = 'יש להשלים את שדות החובה ולתקן את השדות המסומנים.';

            await showMessage({
                title: 'יש להשלים את שדות החובה',
                description: 'נא לבדוק את השדות המסומנים ולתקן את המידע לפני השליחה.',
                type: 'error',
                closeText: 'חזרה לטופס',
            });

            if (firstInvalidField) {
                firstInvalidField.focus({ preventScroll: true });
                firstInvalidField.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            return;
        }

        currentSubmissionId = currentSubmissionId || createSubmissionId();
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), requestTimeoutMs);
        setLoadingState(true);

        try {
            const response = await fetch('/submit-form', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                credentials: 'same-origin',
                signal: controller.signal,
                body: JSON.stringify({
                    submissionId: currentSubmissionId,
                    formData: collectFormData(),
                }),
            });

            const result = await parseJsonResponse(response);

            if (!response.ok || result.status !== 'success') {
                const requestError = new Error(result.code || 'SUBMISSION_FAILED');
                requestError.code = result.code || 'SUBMISSION_FAILED';
                throw requestError;
            }

            formStatus.textContent = 'קובץ ה-PDF נוצר ונשלח בהצלחה.';

            await showMessage({
                title: 'הטופס נשלח בהצלחה',
                description: 'קובץ ה-PDF נוצר ונשלח בהצלחה.',
                type: 'success',
                closeText: 'סיום',
            });

            form.reset();
            form.classList.remove('was-validated');
            form.querySelectorAll('[aria-invalid]').forEach((input) => input.setAttribute('aria-invalid', 'false'));
            currentSubmissionId = null;
            window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
        } catch (error) {
            const isValidationError = error && error.code === 'VALIDATION_ERROR';
            const isTimeout = error && error.name === 'AbortError';
            const description = isValidationError
                ? 'השרת לא קיבל חלק מהמידע. נא לבדוק את השדות המסומנים ולנסות שוב.'
                : isTimeout
                    ? 'השליחה ארכה זמן רב מהצפוי. הנתונים שמילאת נשמרו, וניתן לנסות שוב.'
                    : generalFailureText;

            formStatus.textContent = description;
            await showMessage({
                title: 'שליחת הטופס לא הושלמה',
                description,
                type: 'error',
                closeText: 'חזרה לטופס',
            });
        } finally {
            window.clearTimeout(timeoutId);
            setLoadingState(false);
        }
    }

    for (const field of schema.fields) {
        const input = document.getElementById(field.key);

        if (!input) {
            throw new Error(`Missing form field: ${field.key}`);
        }

        input.addEventListener('input', () => {
            setFieldValidationMessage(input);
            if (input.validity.valid) {
                input.setAttribute('aria-invalid', 'false');
            }
        });
        input.addEventListener('blur', () => setFieldValidationMessage(input));
    }

    form.addEventListener('submit', (event) => {
        event.preventDefault();
        void submitForm();
    });
})();
