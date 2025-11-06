/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Fix: Add global type declaration for the Google Sign-In library
declare global {
  interface Window {
    google: any;
  }
}

import {render, h} from 'preact';
import {useState, useCallback, useRef, useEffect} from 'preact/hooks';
import htm from 'htm';
import {GoogleGenAI, Type} from '@google/genai';

const html = htm.bind(h);
const API_KEY = import.meta.env.VITE_API_KEY;

// --- 🚨 IMPORTANT ACTION REQUIRED 🚨 ---
// You must get your own Google Client ID and add it here.
// The app will show a console error until this is replaced with a valid ID.
// -----------------------------------------
const GOOGLE_CLIENT_ID =
  '119687805584-mvdpjqv1rmgcbv4bkvc5n222ct5ilmfl.apps.googleusercontent.com';

// --- Interfaces ---
interface Color {
  hex: string;
  name: string;
}

interface TieredColors {
  primary: Color[];
  secondary: Color[];
  accent: Color[];
}

interface User {
  name: string;
  email: string;
  picture: string;
  sub: string; // Unique user ID
}

interface HistoryItem {
  id: number;
  imageSrc: string; // Base64 string for persistent storage
  colors: Color[]; // Flat array of all 10 colors
  timestamp: string;
}

// --- Constants for Rate Limiting and Expiration ---
const MAX_ITEMS_PER_DAY = 10;
const EXPIRATION_HOURS = 72; // 3 days
const MILLISECONDS_IN_DAY = 24 * 60 * 60 * 1000;
const MILLISECONDS_IN_HOUR = 60 * 60 * 1000;
const MILLISECONDS_IN_MINUTE = 60 * 1000;

// --- Helper Functions ---

/**
 * Decodes a JWT token from Google Sign-In to get user info.
 * @param {string} token The JWT token string.
 * @returns {any} The decoded payload of the token.
 */
function parseJwt(token: string): any {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map(function (c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        })
        .join(''),
    );
    return JSON.parse(jsonPayload);
  } catch (e) {
    console.error('Error decoding JWT', e);
    return null;
  }
}

/**
 * Converts a File object to a Base64 string.
 * @param {File} file The image file.
 * @returns {Promise<string>} A promise that resolves to the Base64 data URL string.
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read file as Base64.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Uses the Gemini API to analyze an image, identify three key areas, and extract a tiered color palette.
 * @param {File} file The image file.
 * @returns {Promise<{ primary: string[], secondary: string[], accent: string[] }>} A promise that resolves to an object of hex color arrays.
 */
async function extractTieredColorsWithAI(
  file: File,
): Promise<{primary: string[]; secondary: string[]; accent: string[]}> {
  const ai = new GoogleGenAI({apiKey: API_KEY});

  const base64Data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = () =>
      reject(new Error('Failed to read file for AI analysis.'));
    reader.readAsDataURL(file);
  });

  const imagePart = {
    inlineData: {
      mimeType: file.type,
      data: base64Data,
    },
  };

  const textPart = {
    text: `Analyze this image to identify three distinct visual areas based on prominence and area coverage:
              1. The main subject.
              2. The most prominent secondary area (e.g., background or a secondary subject).
              3. An accent area (the third most prominent region).

              Extract a palette of colors from each area:
              - 5 HEX codes from the main subject (Primary).
              - 3 HEX codes from the secondary area.
              - 2 HEX codes from the accent area.

              Return ONLY the 10 HEX codes in the specified JSON format.`,
  };

  const tieredColorsSchema = {
    type: Type.OBJECT,
    properties: {
      primaryColors: {
        type: Type.ARRAY,
        description: 'An array of 5 HEX codes from the main subject.',
        items: {type: Type.STRING},
      },
      secondaryColors: {
        type: Type.ARRAY,
        description: 'An array of 3 HEX codes from the secondary area.',
        items: {type: Type.STRING},
      },
      accentColors: {
        type: Type.ARRAY,
        description: 'An array of 2 HEX codes from the accent area.',
        items: {type: Type.STRING},
      },
    },
    required: ['primaryColors', 'secondaryColors', 'accentColors'],
  };

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: {parts: [imagePart, textPart]},
    config: {
      responseMimeType: 'application/json',
      responseSchema: tieredColorsSchema,
    },
  });

  const colors = JSON.parse(response.text) as {
    primaryColors: string[];
    secondaryColors: string[];
    accentColors: string[];
  };

  const validateColors = (arr: string[], count: number) =>
    Array.isArray(arr) &&
    arr.length === count &&
    arr.every((c) => /^#[0-9a-fA-F]{6}$/.test(c));

  if (
    !validateColors(colors.primaryColors, 5) ||
    !validateColors(colors.secondaryColors, 3) ||
    !validateColors(colors.accentColors, 2)
  ) {
    throw new Error(
      "The AI couldn't identify a clear tiered palette. Please try another image.",
    );
  }

  return {
    primary: colors.primaryColors,
    secondary: colors.secondaryColors,
    accent: colors.accentColors,
  };
}

/**
 * Uses the Gemini API to generate 10 creative names for a list of 10 colors.
 * @param {string[]} hexColors An array of the 10 hex color strings.
 * @returns {Promise<Color[]>} A promise that resolves to an array of 10 color objects with names.
 */
async function generateColorNames(hexColors: string[]): Promise<Color[]> {
  if (hexColors.length !== 10) {
    throw new Error('Expected 10 hex colors for name generation.');
  }
  const ai = new GoogleGenAI({apiKey: API_KEY});

  const colorNameSchema = {
    type: Type.OBJECT,
    required: ['modifier', 'colorName'],
    properties: {
      modifier: {type: Type.STRING},
      colorName: {type: Type.STRING},
    },
  };

  const colorNameListSchema = {
    type: Type.ARRAY,
    description: 'An array of 10 generated color names.',
    items: colorNameSchema,
  };

  const prompt = `You are a color naming expert and designer. You have been given ten HEX color codes: ${hexColors.join(
    ', ',
  )}.

Your task is to generate one creative and evocative name for EACH of the ten colors.

Each name is built from two parts: a 'modifier' (a creative adjective/adverb) and a 'colorName' (a base color name).
IMPORTANT RULE: The 'colorName' field MUST be a simple, well-known base color name (e.g., "Rose", "Blue", "Green"). It MUST NOT contain any descriptive adjectives, adverbs, or the modifier itself. For example, if the modifier is "Dusty", the colorName MUST be "Rose", NOT "Dusty Rose". The final name is combined programmatically later.

Respond in the required JSON format, providing a list of 10 name objects in the same order as the input HEX codes.`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseSchema: colorNameListSchema,
    },
  });

  type NamePart = {modifier: string; colorName: string};
  const nameParts = JSON.parse(response.text) as NamePart[];

  if (
    !Array.isArray(nameParts) ||
    nameParts.length !== 10 ||
    !nameParts.every((p) => p && p.modifier && p.colorName)
  ) {
    throw new Error('Failed to parse color names from the API response.');
  }

  const finalColors = hexColors.map((hex, index) => {
    const name = nameParts[index];
    return {
      hex: hex,
      name: `${name.modifier} ${name.colorName}`,
    };
  });

  return finalColors;
}

/**
 * ⭐️ 타임스탬프를 '방금 전', 'X분 전' 형식으로 변환합니다.
 * @param {string} timestamp The ISO string timestamp.
 * @returns {string} The relative time string.
 */
function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = Date.now();
  const diff = now - date.getTime();

  if (diff < MILLISECONDS_IN_MINUTE) {
    return '방금 전';
  } else if (diff < MILLISECONDS_IN_HOUR) {
    const minutes = Math.floor(diff / MILLISECONDS_IN_MINUTE);
    return `${minutes}분 전`;
  } else if (diff < MILLISECONDS_IN_DAY) {
    const hours = Math.floor(diff / MILLISECONDS_IN_HOUR);
    return `${hours}시간 전`;
  } else {
    const days = Math.floor(diff / MILLISECONDS_IN_DAY);
    return `${days}일 전`;
  }
}

// --- Components ---

const ConfigErrorModal = ({currentOrigin}: {currentOrigin: string}) => {
  return html`
    <div class="config-overlay">
      <div class="config-modal">
        <h2>🚨 Configuration Fix Required</h2>
        <p>
          The application is showing an "origin not allowed" error. This is a
          security setting in your Google Cloud project, not a bug in the app.
        </p>
        <p>
          It means the Client ID you provided is correct, but it hasn't been
          authorized to be used from your current web address.
        </p>
        <p><strong>To fix this, you must do the following:</strong></p>
        <ol>
          <li>
            Go to the
            <a
              href="https://console.cloud.google.com/apis/credentials"
              target="_blank"
              rel="noopener noreferrer"
              >Google Cloud Credentials page</a
            >.
          </li>
          <li>
            Find and click on the name of the "OAuth 2.0 Client ID" you are
            using for this application.
          </li>
          <li>
            Scroll down to the <strong>Authorized JavaScript origins</strong>
            section.
          </li>
          <li>Click <strong>+ ADD URI</strong>.</li>
          <li>
            In the text box that appears, paste the following exact URL:
            <br />
            <strong><code>${currentOrigin}</code></strong>
          </li>
          <li>Click <strong>Save</strong> at the bottom of the page.</li>
        </ol>
        <p>
          After saving, refresh this page. The login should now work correctly.
        </p>
      </div>
    </div>
  `;
};

const ImageUploader = ({
  onImageUpload,
  disabled,
  isResultVisible, 
}: {
  onImageUpload: (file: File) => void;
  disabled: boolean;
  isResultVisible: boolean;
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: h.JSX.TargetedDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragging(true);
    } else if (e.type === 'dragleave') {
      setIsDragging(false);
    }
  };

  const handleDrop = (e: h.JSX.TargetedDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer?.files && e.dataTransfer.files[0]) {
      onImageUpload(e.dataTransfer.files[0]);
    }
  };

  const handleChange = (e: h.JSX.TargetedEvent<HTMLInputElement>) => {
    if (e.currentTarget.files && e.currentTarget.files[0]) {
      onImageUpload(e.currentTarget.files[0]);
    }
  };

  const triggerFileInput = (e?: h.JSX.TargetedMouseEvent<HTMLElement>) => {
    e?.stopPropagation(); 
    if (!disabled && fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  // 텍스트와 스타일 변경 로직
  const displayText = isResultVisible 
    ? '새로운 다른 이미지 검색하기' 
    : 'Upload an image (JPEG, PNG, WEBP) to give its colors emotional names.';
  const displayButtonText = isResultVisible ? '새 이미지 업로드' : 'Upload Image';
  const displayClass = isResultVisible ? 'image-uploader minimized' : 'image-uploader';


  return html`
    <div
      class="${displayClass} ${isDragging ? 'drag-over' : ''}"
      onDragEnter=${handleDrag}
      onDragLeave=${handleDrag}
      onDragOver=${handleDrag}
      onDrop=${handleDrop}
      onClick=${() => triggerFileInput()}
    >
      <input
        type="file"
        id="file-input"
        ref=${fileInputRef}
        accept="image/jpeg, image/png, image/webp" 
        onChange=${handleChange}
        disabled=${disabled}
        aria-hidden="true"
        style="display:none"
      />
      <p>${displayText}</p>
      <button
        class="upload-button"
        onClick=${(e: any) => triggerFileInput(e)}
        disabled=${disabled}
      >
        ${displayButtonText}
      </button>
      ${!isResultVisible && html`<p class="drag-drop-text">...or drag and drop</p>`}
    </div>
  `;
};

const ColorSwatch = ({color}: {color: Color}) => {
  const tooltipRef = useRef<HTMLSpanElement>(null);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      const tooltip = tooltipRef.current;
      if (tooltip) {
        tooltip.classList.add('visible');
        setTimeout(() => tooltip.classList.remove('visible'), 1500);
      }
    });
  };

  return html`
    <div class="color-swatch">
      <div
        class="color-display"
        style=${{backgroundColor: color.hex}}
      ></div>
      <div class="color-info">
        <p class="color-name">${color.name}</p>
        <button
          class="color-hex"
          onClick=${() => copyToClipboard(color.hex)}
          aria-label="Copy color code ${color.hex}"
        >
          ${color.hex}
          <span ref=${tooltipRef} class="copy-tooltip" aria-live="polite"
            >Copied!</span
          >
        </button>
      </div>
    </div>
  `;
};

const Loader = ({message}: {message: string}) => {
  return html`
    <div class="loader-container">
      <div class="loader"></div>
      <p>${message}</p>
    </div>
  `;
};

const PaletteDisplay = ({colors}: {colors: TieredColors}) => {
  const combinedColors = [...colors.secondary, ...colors.accent];

  return html`
    <div class="palette-container">
      <div class="palette-section">
        <h2>Primary Colors</h2>
        <div class="color-palette">
          ${colors.primary.map(
            (color) => html`<${ColorSwatch} color=${color} />`,
          )}
        </div>
      </div>
      <div class="palette-section">
        <h2>Secondary + Accent</h2>
        <div class="color-palette">
          ${combinedColors.map(
            (color) => html`<${ColorSwatch} color=${color} />`,
          )}
        </div>
      </div>
    </div>
  `;
};

// HistoryItemCard 컴포넌트 (SVG Base64 로드를 위한 HTML)
const HistoryItemCard = ({
  item,
  onClick,
  onDelete,
}: {
  item: HistoryItem;
  onClick: (item: HistoryItem) => void;
  onDelete: (id: number) => void;
}) => {
  const handleDeleteClick = (e: h.JSX.TargetedMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation(); 
    onDelete(item.id);
  };

  return html`
    <div
      class="history-item-card clickable"
      onClick=${() => onClick(item)}
      aria-label=${`Load palette generated on ${formatTimestamp(item.timestamp)}`}
      tabIndex="0"
      role="button"
    >
      <button
        class="delete-button styled-delete svg-background-trash" 
        onClick=${handleDeleteClick}
        aria-label="Delete history item"
        title="Delete this history item"
      >
        </button>

      <img
        src=${item.imageSrc}
        alt="Previously analyzed image"
        class="history-item-thumbnail"
      />
      <div class="history-item-palette">
        <div class="history-palette-row">
          ${item.colors
            .slice(0, 5)
            .map(
              (c) =>
                html`<div
                  class="history-item-swatch"
                  style=${{backgroundColor: c.hex}}
                  title=${c.name}
                ></div>`,
            )}
        </div>
        <div class="history-palette-row">
          ${item.colors
            .slice(5)
            .map(
              (c) =>
                html`<div
                  class="history-item-swatch"
                  style=${{backgroundColor: c.hex}}
                  title=${c.name}
                ></div>`,
            )}
        </div>
      </div>
      <p class="history-item-timestamp">
        ${formatTimestamp(item.timestamp)}
      </p>
    </div>
  `;
};

const App = () => {
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [tieredColors, setTieredColors] = useState<TieredColors | null>(null);
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showConfigError, setShowConfigError] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null); 

  const isResultVisible = !!(imagePreview && (tieredColors || loadingMessage));

  // --- Auth Effects ---
  const handleCredentialResponse = useCallback((response: any) => {
    if (response.credential) {
      const userData = parseJwt(response.credential);
      setUser(userData);
      localStorage.setItem('user', JSON.stringify(userData));
    } else {
      console.error('Login failed:', response);
      if (response.error === 'popup_closed_by_user') return;
      if (response.error === 'origin_not_allowed') {
        setShowConfigError(true);
      }
    }
  }, []);

  const handleLogout = useCallback(() => {
    setUser(null);
    localStorage.removeItem('user');
    window.google.accounts.id.disableAutoSelect();
  }, []);

  useEffect(() => {
    // Check for saved user on load
    const savedUser = localStorage.getItem('user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
    }

    // Initialize Google Sign-In
    if (window.google) {
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: handleCredentialResponse,
        auto_select: true,
      });

      // Render the Google Sign-In button
      window.google.accounts.id.renderButton(
        document.getElementById('google-signin-button'),
        {theme: 'outline', size: 'large'},
      );
    } else {
      console.error('Google Sign-In script not loaded.');
    }
  }, [handleCredentialResponse]);

  // --- History Effects and Expiration Logic ---
  const loadHistory = useCallback((userId: string) => {
    const savedHistory = localStorage.getItem(`history_${userId}`);
    if (savedHistory) {
      const allHistory: HistoryItem[] = JSON.parse(savedHistory);
      const expirationTime = Date.now() - (EXPIRATION_HOURS * MILLISECONDS_IN_HOUR);
      
      // 72시간(3일)이 지나지 않은 항목만 필터링
      const validHistory = allHistory.filter(item => 
        new Date(item.timestamp).getTime() > expirationTime
      );

      setHistory(validHistory);
      localStorage.setItem(`history_${userId}`, JSON.stringify(validHistory));
    } else {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    if (user) {
      loadHistory(user.sub);
    } else {
      setHistory([]);
    }
  }, [user, loadHistory]);

  useEffect(() => {
    if (user && history.length > 0) {
      localStorage.setItem(`history_${user.sub}`, JSON.stringify(history));
    }
  }, [history, user]);

  const handleDeleteHistoryItem = useCallback((id: number) => {
    if (!user) return;
    
    setHistory(prevHistory => {
      const newHistory = prevHistory.filter(item => item.id !== id);
      return newHistory;
    });
  }, [user]);

  // --- Core App Logic ---
  const handleImageUpload = useCallback(
    async (file: File) => {
      setError(null);
      setTieredColors(null);

      // 24시간 동안 10개 제한 로직
      if (user) {
        const twentyFourHoursAgo = Date.now() - MILLISECONDS_IN_DAY;
        const itemsToday = history.filter(item => 
          new Date(item.timestamp).getTime() > twentyFourHoursAgo
        );

        if (itemsToday.length >= MAX_ITEMS_PER_DAY) {
          setError(`You have reached the limit of ${MAX_ITEMS_PER_DAY} analyses in the last 24 hours. Please try again tomorrow.`);
          return;
        }
      }

      setLoadingMessage('Preparing your image...');

      // 1. Base64로 인코딩하여 imagePreview에 설정
      const base64Image = await fileToBase64(file);
      setImagePreview(base64Image); 

      try {
        setLoadingMessage('Extracting tiered color palette...');
        const tieredHex = await extractTieredColorsWithAI(file);
        const allHex = [
          ...tieredHex.primary,
          ...tieredHex.secondary,
          ...tieredHex.accent,
        ];

        setLoadingMessage('Generating creative color names...');
        const namedColors = await generateColorNames(allHex);

        const newTieredColors: TieredColors = {
          primary: namedColors.slice(0, 5),
          secondary: namedColors.slice(5, 8),
          accent: namedColors.slice(8, 10),
        };
        setTieredColors(newTieredColors);

        // Add to history if user is logged in
        if (user) { 
          const newHistoryItem: HistoryItem = {
            id: Date.now(),
            imageSrc: base64Image,
            colors: namedColors, // 모든 색상 저장
            timestamp: new Date().toISOString(),
          };
          setHistory((prevHistory) => [newHistoryItem, ...prevHistory]);
        }

        // 결과 로드 후 결과 창으로 스크롤 (부드러운 이동)
        if (resultsRef.current) {
            resultsRef.current.scrollIntoView({ behavior: 'smooth' });
        }
      } catch (e) {
        console.error(e);
        setError(
          e instanceof Error
            ? e.message
            : 'An unknown error occurred during analysis.',
        );
      } finally {
        setLoadingMessage(null);
      }
    },
    [user, history], 
  );

  // 신규 함수: 히스토리 항목을 클릭했을 때 데이터를 현재 화면에 로드하고 스크롤
  const handleLoadHistoryItem = useCallback((item: HistoryItem) => {
    setError(null);
    setLoadingMessage(null);
    setImagePreview(item.imageSrc);

    // 저장된 colors 배열 (10개)을 TieredColors 형식으로 분할하여 로드
    const primary = item.colors.slice(0, 5);
    const secondary = item.colors.slice(5, 8);
    const accent = item.colors.slice(8, 10);
    
    setTieredColors({ primary, secondary, accent });

    // 결과 창으로 스크롤 (부드러운 이동)
    if (resultsRef.current) {
        resultsRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, []);

  return html`
    ${showConfigError &&
    html`<${ConfigErrorModal} currentOrigin=${window.location.origin} />`}
    <header>
      ${user
        ? html`
            <div class="user-profile">
              <img
                src=${user.picture}
                alt="User profile picture"
                class="profile-pic"
              />
              <button class="logout-button" onClick=${handleLogout}>
                Logout
              </button>
            </div>
          `
        : html`
            <div class="user-profile">
              <div id="google-signin-button"></div>
            </div>
          `}
      <div class="header-content">
        <h1>Palette Mood</h1>
        <p>What is the name of your color?</p>
      </div>
    </header>

    <main>
      <div class=${'glass-panel ' + (isResultVisible ? 'minimized-panel' : '')}>
        <${ImageUploader}
          onImageUpload=${handleImageUpload}
          disabled=${!!loadingMessage}
          isResultVisible=${isResultVisible}
        />
      </div>

      ${error && html`<p class="error-message">${error}</p>`}

      <div class="results-container" ref=${resultsRef}>
        ${loadingMessage && html`<${Loader} message=${loadingMessage} />`}

        ${isResultVisible &&
        html`
          <div class="current-result-view">
            <div class="preview-container">
              <img src=${imagePreview} alt="Uploaded image preview" />
            </div>
            ${tieredColors && html`<${PaletteDisplay} colors=${tieredColors} />`}
          </div>
        `}
      </div>

      ${user &&
      html`
        <section class="history-section">
          <h2>Your Palette History</h2>
          <p class="history-description">
            Previously generated palettes are saved for 72 hours. And you can generate up to 10 per a day.
          </p>
          ${history.length > 0
            ? html`
                <div class="history-grid">
                  ${history.map(
                    (item) =>
                      html`<${HistoryItemCard}
                        item=${item}
                        onClick=${handleLoadHistoryItem}
                        onDelete=${handleDeleteHistoryItem}
                      />`,
                  )}
                </div>
              `
            : html`<p class="history-empty">
                You have no saved palettes yet. Upload an image to start!
              </p>`}
        </section>
      `}
    </main>
  `;
};

render(html`<${App} />`, document.getElementById('app'));