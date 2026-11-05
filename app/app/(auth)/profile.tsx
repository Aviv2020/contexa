import React, { useState } from 'react';
import { View } from 'react-native';
import { useI18n } from '../../src/i18n';
import { useSession } from '../../src/state/session';
import { Button, Field, Screen, Title } from '../../src/ui/kit';

export default function Profile() {
  const { t } = useI18n();
  const { setProfile } = useSession();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Screen>
      <View style={{ flex: 1, padding: 24, justifyContent: 'center', gap: 16 }}>
        <Title>{t('profileTitle')}</Title>
        <Field label={t('fullName')} value={name} onChangeText={setName} autoFocus textContentType="name" />
        <Button title={t('continue')} disabled={!name.trim()} loading={busy} onPress={async () => { setBusy(true); try { await setProfile(name.trim()); } finally { setBusy(false); } }} />
      </View>
    </Screen>
  );
}
