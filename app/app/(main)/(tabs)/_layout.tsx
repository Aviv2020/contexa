import React from 'react';
import { Text, type ColorValue } from 'react-native';
import { Tabs } from 'expo-router';
import { useI18n } from '../../../src/i18n';
import { useSession } from '../../../src/state/session';
import { useTheme } from '../../../src/ui/theme';

const icon = (glyph: string) => ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 20 }}>{glyph}</Text>;

export default function TabsLayout() {
  const { t } = useI18n();
  const th = useTheme();
  const { org } = useSession();
  const isAdmin = org?.role === 'admin';
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: th.brand, tabBarStyle: { backgroundColor: th.surface, borderTopColor: th.border } }}>
      <Tabs.Screen name="index" options={{ title: t('tabGroups'), tabBarIcon: icon('💬') }} />
      <Tabs.Screen name="search" options={{ title: t('tabSearch'), tabBarIcon: icon('🔍') }} />
      {/* The admin tab exists only for admins (§4.6) */}
      <Tabs.Screen name="admin" options={{ title: t('tabAdmin'), tabBarIcon: icon('⚙️'), href: isAdmin ? undefined : null }} />
    </Tabs>
  );
}
