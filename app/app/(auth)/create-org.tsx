import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { useI18n } from '../../src/i18n';
import { useSession } from '../../src/state/session';
import { formatRecoveryKey, generateKeyPair, toB64 } from '../../src/crypto/e2e';
import { Button, ErrorText, Field, Screen, Title, Muted } from '../../src/ui/kit';
import { useTheme } from '../../src/ui/theme';

/**
 * Standalone org sign-up. The org recovery key (§6.5) is generated on the device; only its public half is uploaded.
 * The private half is shown exactly once, before the org is created.
 */
export default function CreateOrg() {
  const { t, locale } = useI18n();
  const th = useTheme();
  const { createOrg } = useSession();
  const [name, setName] = useState('');
  const [label, setLabel] = useState(locale === 'he' ? 'מטופל' : 'Patient');
  const [plural, setPlural] = useState(locale === 'he' ? 'מטופלים' : 'Patients');
  const [jobTitle, setJobTitle] = useState('');
  const [step, setStep] = useState<'form' | 'recovery'>('form');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const recovery = useMemo(() => generateKeyPair(), []);

  if (step === 'recovery') {
    return (
      <Screen scroll>
        <Title sub={t('recoveryBody')}>{t('recoveryTitle')}</Title>
        <View style={{ backgroundColor: th.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: th.border }}>
          <Text selectable={false} style={{ fontFamily: 'Courier', fontSize: 18, lineHeight: 30, color: th.text, textAlign: 'center', writingDirection: 'ltr' }}>
            {formatRecoveryKey(recovery.privateKey)}
          </Text>
        </View>
        <ErrorText>{error}</ErrorText>
        <Button
          title={t('recoveryConfirm')}
          loading={busy}
          onPress={async () => {
            setBusy(true);
            try {
              await createOrg({ name: name.trim(), contextLabel: label.trim(), contextLabelPlural: plural.trim(), jobTitle: jobTitle.trim(), recoveryPublicKey: toB64(recovery.publicKey) });
              recovery.privateKey.fill(0);
              router.replace('/(main)/(tabs)');
            } catch {
              setError(t('error'));
            } finally {
              setBusy(false);
            }
          }}
        />
      </Screen>
    );
  }
  return (
    <Screen scroll>
      <Title>{t('createOrg')}</Title>
      <Field label={t('orgName')} value={name} onChangeText={setName} />
      <Field label={t('contextLabel')} value={label} onChangeText={setLabel} hint={t('contextLabelExamples')} />
      <Field label={t('contextLabelPlural')} value={plural} onChangeText={setPlural} />
      <Field label={t('jobTitle')} value={jobTitle} onChangeText={setJobTitle} />
      <Button title={t('continue')} disabled={!name.trim() || !label.trim() || !plural.trim()} onPress={() => setStep('recovery')} />
      <Button variant="ghost" title={t('cancel')} onPress={() => router.back()} />
      <Muted> </Muted>
    </Screen>
  );
}
