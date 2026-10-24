export const PACKAGE_NAME = "@codesh/highlight";

export {
  contrastRatio,
  deltaE,
  hexToOklab,
  hexToRgb,
  mix,
  oklchToHex,
  relativeLuminance,
  rgbToHex,
} from "./color.js";
export {
  DETECT_SAMPLE_BYTES,
  type DetectInput,
  type Detection,
  detectLanguage,
} from "./detect.js";
export { GALLERY_LANGUAGES } from "./gallery-languages.js";
export { GALLERY_SAMPLES as SAMPLES } from "./gallery-samples.js";
export type { GrammarLoader } from "./grammars.js";
export {
  fenceLanguage,
  findLanguage,
  getLanguage,
  LANGUAGES,
  type LanguageEntry,
  languageDescription,
  languageForFilename,
  languagesForExtension,
  languagesForFilename,
  PLAIN_TEXT_ID,
} from "./languages.js";
export {
  PARTICIPANT_COLORS,
  type ParticipantColor,
  participantColor,
} from "./participants.js";
export type { ThemePalette, ThemeSurfaces } from "./theme-colors.js";
export {
  DEFAULT_THEME_ID,
  EDITOR_THEMES,
  type EditorTheme,
  getEditorTheme,
  isThemeId,
  KEYWORD_WEIGHT,
  type ThemeId,
  TOKEN_NAMES,
  type TokenName,
} from "./themes.js";
