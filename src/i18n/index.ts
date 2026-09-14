import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import messages from './local/index';

// Safari-safe: sem LanguageDetector para evitar TDZ em i18next-browser-languagedetector
i18n
  .use(initReactI18next)
  .init({
    lng: 'en',
    fallbackLng: 'en',
    debug: false,
    resources: messages,
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;