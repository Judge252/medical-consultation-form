(function initMedicalFormSchema(root, factory) {
    const schema = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = schema;
    } else {
        root.MEDICAL_FORM_SCHEMA = schema;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createSchema() {
    'use strict';

    const sections = [
        {
            id: 'patient-details',
            title: 'פרטי המטופל',
            fields: [
                { key: 'patientName', label: 'שם המטופל', type: 'text', required: true, maxLength: 120, wide: false },
                { key: 'patientPhone', label: 'טלפון', type: 'text', required: true, maxLength: 24, direction: 'ltr', validation: 'phone', wide: false },
                { key: 'address', label: 'כתובת', type: 'text', required: true, maxLength: 240, wide: false },
                { key: 'patientId', label: 'ת.ז', type: 'text', required: true, maxLength: 20, direction: 'ltr', validation: 'identity', wide: false },
                { key: 'age', label: 'גיל', type: 'number', required: true, min: 0, max: 130, wide: false },
                { key: 'gender', label: 'מין', type: 'enum', required: true, values: ['זכר', 'נקבה', 'אחר'], maxLength: 20, wide: false },
            ],
        },
        {
            id: 'medical-consultation',
            title: 'ייעוץ רפואי',
            fields: [
                { key: 'referralReason', label: 'סיבת הפניה/תלונות', type: 'textarea', maxLength: 3000, wide: true },
                { key: 'backgroundDiseases', label: 'מחלות רקע', type: 'textarea', maxLength: 3000, wide: false },
                { key: 'regularMedications', label: 'תרופות קבועות', type: 'textarea', maxLength: 3000, wide: false },
                { key: 'occupationActivity', label: 'עיסוק – רמת הפעילות הגופנית', type: 'textarea', maxLength: 3000, wide: false },
                { key: 'nutritionHabits', label: 'הרגלי תזונה', type: 'textarea', maxLength: 3000, wide: false },
            ],
        },
        {
            id: 'physical-examination',
            title: 'בדיקה פיזיקאלית וגופנית',
            fields: [
                { key: 'consciousness', label: 'הכרה', type: 'text', maxLength: 300, wide: false },
                { key: 'temperature', label: 'חום', type: 'text', maxLength: 40, direction: 'ltr', wide: false },
                { key: 'pulse', label: 'דופק', type: 'text', maxLength: 40, direction: 'ltr', wide: false },
                { key: 'bloodPressure', label: 'ל״ד', type: 'text', maxLength: 40, direction: 'ltr', wide: false },
                { key: 'observation', label: 'הסתכלות', type: 'textarea', maxLength: 2000, wide: true },
                { key: 'bodyStructure', label: 'מבנה גוף', type: 'textarea', maxLength: 1000, wide: false },
                { key: 'weight', label: 'משקל', type: 'text', maxLength: 40, direction: 'ltr', wide: false },
                { key: 'skinCondition', label: 'מצב העור', type: 'textarea', maxLength: 1500, wide: false },
                { key: 'palpation', label: 'מישוש', type: 'textarea', maxLength: 1500, wide: false },
                { key: 'vasPainScore', label: 'כאב - לפי VAS', type: 'number', min: 0, max: 10, wide: false },
                { key: 'jointExamination', label: 'בדיקת מפרקים', type: 'textarea', maxLength: 3000, wide: false },
                { key: 'muscleExamination', label: 'בדיקת שרירים', type: 'textarea', maxLength: 3000, wide: false },
                { key: 'neurologicalExamination', label: 'בדיקה עצבית — מוטורית / סנסורית', type: 'textarea', maxLength: 3000, wide: false },
                { key: 'balanceAndFalls', label: 'שיווי משקל', type: 'textarea', maxLength: 3000, wide: false },
                { key: 'specialTests', label: 'בדיקות מיוחדות', type: 'textarea', maxLength: 3000, wide: false },
                { key: 'imagingResults', label: 'תוצאות בדיקה והדמיה', type: 'textarea', maxLength: 3000, wide: false },
                { key: 'bloodTests', label: 'בדיקות דם', type: 'textarea', maxLength: 3000, wide: true },
            ],
        },
        {
            id: 'clinical-conclusion',
            title: 'סיכום קליני',
            fields: [
                { key: 'consultationSummary', label: 'סיכום בדיקה וייעוץ', type: 'textarea', maxLength: 4000, wide: true },
                { key: 'diagnosis', label: 'אבחנה', type: 'textarea', maxLength: 3000, wide: true },
                { key: 'treatmentPlan', label: 'תכנית טיפול והמלצות', type: 'textarea', maxLength: 4000, wide: true },
            ],
        },
        {
            id: 'medical-professional',
            title: 'פרטי הגורם הרפואי',
            fields: [
                { key: 'doctorName', label: 'שם הרופא', type: 'text', maxLength: 120, wide: false },
                { key: 'licenseNumber', label: 'מספר רישיון', type: 'text', maxLength: 60, direction: 'ltr', wide: false },
                { key: 'doctorSignature', label: 'חתימה', type: 'text', maxLength: 120, wide: false },
                { key: 'examinationDate', label: 'תאריך', type: 'date', maxLength: 10, direction: 'ltr', wide: false },
            ],
        },
    ];

    const fields = sections.flatMap((section) => section.fields);
    const fieldMap = Object.fromEntries(fields.map((field) => [field.key, field]));

    return Object.freeze({
        version: 1,
        sections: Object.freeze(sections),
        fields: Object.freeze(fields),
        fieldMap: Object.freeze(fieldMap),
    });
});
