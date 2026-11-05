import '../src/polyfills';
import React, { useEffect, useState } from 'react';
import { AppState, Platform, Text, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as ScreenCapture from 'expo-screen-capture';
import * as Notifications from 'expo-notifications';
import { I18nProvider, useI18n } from '../src/i18n';
import { SessionProvider, useSession } from '../src/state/session';
import { api } from '../src/api/client';
import { Button, Center, Logo, Muted, Screen, Title } from '../src/ui/kit';
import { useTheme } from '../src/ui/theme';

// Lock-screen notifications never carry content; this only controls in-app presentation (§4.4).
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }),
});

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <SessionProvider>
          <Root />
        </SessionProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}

function Root() {
  const { status, touch } = useSession();
  useSecurity();
  usePush();
  const t = useTheme();
  const gate = gateScreen(status);
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }} onTouchStart={touch}>
      <StatusBar style="auto" />
      {gate ?? (
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }}>
          <Stack.Protected guard={status === 'signed-out'}>
            <Stack.Screen name="(auth)/phone" />
            <Stack.Screen name="(auth)/otp" />
          </Stack.Protected>
          <Stack.Protected guard={status === 'needs-profile'}>
            <Stack.Screen name="(auth)/profile" />
          </Stack.Protected>
          <Stack.Protected guard={status === 'no-org' || status === 'ready'}>
            <Stack.Screen name="(auth)/orgs" />
            <Stack.Screen name="(auth)/create-org" />
          </Stack.Protected>
          <Stack.Protected guard={status === 'ready'}>
            <Stack.Screen name="(main)" />
          </Stack.Protected>
        </Stack>
      )}
      <PrivacyCover />
      <NoticeRedirect />
    </View>
  );
}

function gateScreen(status: string) {
  switch (status) {
    case 'booting':
      return <Splash />;
    case 'compromised':
      return <Blocked kind="compromised" />;
    case 'no-biometrics':
      return <Blocked kind="no-biometrics" />;
    case 'locked':
      return <LockScreen />;
    case 'rekey':
      return <Blocked kind="rekey" />;
    default:
      return null;
  }
}

function Splash() {
  return (
    <Screen>
      <Center>
        <Logo size={88} />
      </Center>
    </Screen>
  );
}

function Blocked({ kind }: { kind: 'compromised' | 'no-biometrics' | 'rekey' }) {
  const { t } = useI18n();
  const title = kind === 'compromised' ? t('compromisedTitle') : kind === 'rekey' ? t('rekeyTitle') : t('biometricRequiredTitle');
  const body = kind === 'compromised' ? t('compromisedBody') : kind === 'rekey' ? t('rekeyBody') : t('biometricRequiredBody');
  return (
    <Screen>
      <Center>
        <Logo />
        <Title sub={body}>{title}</Title>
        {kind === 'rekey' ? <RekeyContinue /> : null}
      </Center>
    </Screen>
  );
}

function RekeyContinue() {
  const { t } = useI18n();
  const [, force] = useState(0);
  return <Button title={t('continue')} onPress={() => { force(1); router.replace('/(auth)/phone'); }} />;
}

function LockScreen() {
  const { t } = useI18n();
  const { unlock, unlockFailures } = useSession();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await unlock();
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Screen>
      <Center>
        <Logo size={80} />
        <Title>{t('locked')}</Title>
        {unlockFailures > 0 ? <Muted style={{ textAlign: 'center' }}>{t('unlockFailed', { n: unlockFailures })}</Muted> : null}
        <Button title={t('unlock')} onPress={go} loading={busy} style={{ alignSelf: 'stretch' }} />
      </Center>
    </Screen>
  );
}

/** Hides content in the app switcher / when the app goes to the background (§6.1). */
function PrivacyCover() {
  const [hidden, setHidden] = useState(false);
  const t = useTheme();
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setHidden(s !== 'active'));
    return () => sub.remove();
  }, []);
  if (!hidden) return null;
  return (
    <View style={{ position: 'absolute', inset: 0, backgroundColor: t.brand, alignItems: 'center', justifyContent: 'center' }}>
      <Logo size={88} />
    </View>
  );
}

function NoticeRedirect() {
  const { notice, dismissNotice } = useSession();
  const { t } = useI18n();
  const th = useTheme();
  if (!notice) return null;
  return (
    <View style={{ position: 'absolute', left: 16, right: 16, bottom: 48, backgroundColor: th.surface, borderRadius: 14, padding: 16, gap: 8, borderWidth: 1, borderColor: th.border, elevation: 4 }}>
      <Text style={{ fontWeight: '700', color: th.text }}>{t('wipedTitle')}</Text>
      <Muted>{t('wipedBody')}</Muted>
      <Button title={t('close')} variant="secondary" onPress={dismissNotice} />
    </View>
  );
}

/** Screenshot blocking (Android FLAG_SECURE, iOS capture protection) and screenshot audit on iOS (§6.1). */
function useSecurity() {
  const { status, org } = useSession();
  useEffect(() => {
    void ScreenCapture.preventScreenCaptureAsync('contexa');
    if (Platform.OS === 'ios') void ScreenCapture.enableAppSwitcherProtectionAsync(0.9).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (status !== 'ready' || !org) return;
    const sub = ScreenCapture.addScreenshotListener(() => {
      void api.post('/v1/security-events', { type: 'screenshot' }).catch(() => undefined);
    });
    return () => sub.remove();
  }, [status, org]);
}

/** Registers the push token; tapping a notification opens the right org and group (§3.5). */
function usePush() {
  const { status, selectOrg, org } = useSession();
  useEffect(() => {
    if (status !== 'ready') return;
    (async () => {
      const perm = await Notifications.requestPermissionsAsync();
      if (!perm.granted) return;
      try {
        const token = (await Notifications.getExpoPushTokenAsync()).data;
        await api.put('/v1/me/device', { pushToken: token });
      } catch {
        /* simulator or no project id */
      }
    })();
  }, [status]);
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(async (resp) => {
      const data = resp.notification.request.content.data as { orgId?: string; groupId?: string };
      if (!data?.orgId) return;
      if (org?.org.id !== data.orgId) await selectOrg(data.orgId);
      if (data.groupId) router.push({ pathname: '/(main)/group/[id]', params: { id: data.groupId } });
    });
    return () => sub.remove();
  }, [org, selectOrg]);
}
