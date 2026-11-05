import React, { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { api } from '../../../../src/api/client';
import { useI18n } from '../../../../src/i18n';
import { useSession } from '../../../../src/state/session';
import { Button, Field, Muted, Screen, Title } from '../../../../src/ui/kit';

/** Context type: label, plural, header fields (§2.2). The whole UI follows this label. */
export default function ContextType() {
  const { t } = useI18n();
  const { org, refreshOrg } = useSession();
  const ct = org?.contextType;
  const [label, setLabel] = useState(ct?.label ?? '');
  const [plural, setPlural] = useState(ct?.labelPlural ?? '');
  const [fields, setFields] = useState(ct?.headerFields ?? []);
  const [busy, setBusy] = useState(false);
  return (
    <Screen scroll>
      <Title sub={t('contextLabelExamples')}>{t('contextType')}</Title>
      <Field label={t('contextLabel')} value={label} onChangeText={setLabel} />
      <Field label={t('contextLabelPlural')} value={plural} onChangeText={setPlural} />
      <Muted>{t('headerFields')}</Muted>
      {fields.map((f, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}><Field placeholder="key" autoCapitalize="none" value={f.key} onChangeText={(key) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, key: key.replace(/[^\w-]/g, '') } : x)))} /></View>
          <View style={{ flex: 2 }}><Field placeholder={t('name')} value={f.label} onChangeText={(l) => setFields((fs) => fs.map((x, j) => (j === i ? { ...x, label: l } : x)))} /></View>
          <Button variant="ghost" title="✕" onPress={() => setFields((fs) => fs.filter((_, j) => j !== i))} />
        </View>
      ))}
      <Button variant="secondary" title={`＋ ${t('addField')}`} onPress={() => setFields((fs) => [...fs, { key: '', label: '' }])} />
      <Button title={t('save')} loading={busy} disabled={!label.trim() || !plural.trim()} onPress={async () => {
        setBusy(true);
        try {
          await api.put('/v1/admin/context-type', { label, labelPlural: plural, headerFields: fields.filter((f) => f.key && f.label) });
          await refreshOrg();
          router.back();
        } finally {
          setBusy(false);
        }
      }} />
    </Screen>
  );
}
