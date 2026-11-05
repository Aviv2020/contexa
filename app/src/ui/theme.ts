import { useColorScheme } from 'react-native';

const light = {
  bg: '#F6F7F5',
  surface: '#FFFFFF',
  surfaceAlt: '#EEF2EF',
  text: '#14201F',
  textMuted: '#5D6B69',
  border: '#DDE3E0',
  brand: '#0F3D3E',
  brandText: '#FFFFFF',
  accent: '#1F8A70',
  accentSoft: '#DDF1EA',
  bubbleMine: '#DDF1EA',
  bubbleOther: '#FFFFFF',
  danger: '#B42318',
  warning: '#B54708',
  badge: '#1F8A70',
  overlay: 'rgba(10,20,20,0.45)',
};

const dark: typeof light = {
  bg: '#0C1414',
  surface: '#152020',
  surfaceAlt: '#1C2A2A',
  text: '#E8EFED',
  textMuted: '#97A6A3',
  border: '#2A3938',
  brand: '#0F3D3E',
  brandText: '#FFFFFF',
  accent: '#3FB68F',
  accentSoft: '#173A31',
  bubbleMine: '#1D4A3E',
  bubbleOther: '#1C2A2A',
  danger: '#F97066',
  warning: '#FDB022',
  badge: '#3FB68F',
  overlay: 'rgba(0,0,0,0.6)',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const radius = { sm: 8, md: 12, lg: 18, pill: 999 };
