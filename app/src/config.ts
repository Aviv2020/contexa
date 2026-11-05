import Constants from 'expo-constants';

export const API_URL: string = process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra?.apiUrl as string) ?? 'http://localhost:8787';
export const WS_URL = API_URL.replace(/^http/, 'ws') + '/v1/ws';
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGES_PER_SEND = 10;
export const EDIT_WINDOW_MS = 15 * 60_000;
export const MAX_BIOMETRIC_FAILURES = 5;
