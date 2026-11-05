import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { router } from 'expo-router';
import { useI18n } from '../../src/i18n';
import { useSession } from '../../src/state/session';
import { ApiError } from '../../src/api/client';
import { Button, ErrorText, Field, Logo, Screen, Title, Muted } from '../../src/ui/kit';

export default function Phone() {
  const { t, setLocale, locale } = useI18n();
  const { requestOtp } = useSession();
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await requestOtp(phone);
      router.push({ pathname: '/(auth)/otp', params: { phone, requestId: r.requestId, devCode: r.devCode ?? '' } });
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'invalid_phone' ? t('phoneHint') : err.data?.retryAfterSec ? t('resendIn', { s: String(err.data.retryAfterSec) }) : t('error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 16 }}>
        <Logo size={72} />
        <Title sub={t('phoneHint')}>{t('phoneTitle')}</Title>
        <Field value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" placeholder={t('phonePlaceholder')} autoFocus />
        <ErrorText>{error}</ErrorText>
        <Button title={t('continue')} onPress={submit} loading={busy} disabled={phone.replace(/\D/g, '').length < 9} />
        <View style={{ alignItems: 'center', marginTop: 24 }}>
          <Button variant="ghost" title={t('language')} onPress={() => setLocale(locale === 'he' ? 'en' : 'he')} />
          <Muted>{t('tagline')}</Muted>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
