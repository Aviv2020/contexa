import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useI18n } from '../../src/i18n';
import { useSession } from '../../src/state/session';
import { ApiError } from '../../src/api/client';
import { Button, ErrorText, Field, Screen, Title, Muted } from '../../src/ui/kit';

export default function Otp() {
  const params = useLocalSearchParams<{ phone: string; requestId: string; devCode?: string }>();
  const { t } = useI18n();
  const { verifyOtp, requestOtp } = useSession();
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState(params.requestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [wait, setWait] = useState(60);

  useEffect(() => {
    const iv = setInterval(() => setWait((w) => Math.max(0, w - 1)), 1000);
    return () => clearInterval(iv);
  }, [requestId]);

  const submit = async (value = code) => {
    setBusy(true);
    setError('');
    try {
      await verifyOtp(params.phone, requestId, value);
    } catch (e) {
      const err = e as ApiError;
      setError(err.code === 'mismatch' ? t('attemptsLeft', { n: String(err.data.attemptsLeft ?? 0) }) : t('error'));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    try {
      const r = await requestOtp(params.phone);
      setRequestId(r.requestId);
      setWait(60);
    } catch (e) {
      const s = (e as ApiError).data?.retryAfterSec;
      setError(s ? t('resendIn', { s: String(s) }) : t('error'));
    }
  };

  return (
    <Screen>
      <View style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 16 }}>
        <Title sub={t('otpHint', { phone: params.phone })}>{t('otpTitle')}</Title>
        <Field
          value={code}
          onChangeText={(v) => {
            const d = v.replace(/\D/g, '').slice(0, 6);
            setCode(d);
            if (d.length === 6) void submit(d);
          }}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="sms-otp"
          autoFocus
          style={{ fontSize: 28, letterSpacing: 10, textAlign: 'center' }}
        />
        {params.devCode ? <Muted>DEV: {params.devCode}</Muted> : null}
        <ErrorText>{error}</ErrorText>
        <Button title={t('continue')} onPress={() => submit()} loading={busy} disabled={code.length !== 6} />
        <Button variant="ghost" title={wait ? t('resendIn', { s: wait }) : t('resend')} onPress={resend} disabled={wait > 0} />
      </View>
    </Screen>
  );
}
