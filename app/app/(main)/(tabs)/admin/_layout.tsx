import { Stack } from 'expo-router';
import { useTheme } from '../../../../src/ui/theme';

export default function AdminLayout() {
  const t = useTheme();
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }} />;
}
