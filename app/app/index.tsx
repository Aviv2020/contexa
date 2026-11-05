import { Redirect } from 'expo-router';
import { useSession } from '../src/state/session';

export default function Index() {
  const { status } = useSession();
  if (status === 'signed-out' || status === 'rekey') return <Redirect href="/(auth)/phone" />;
  if (status === 'needs-profile') return <Redirect href="/(auth)/profile" />;
  if (status === 'no-org') return <Redirect href="/(auth)/orgs" />;
  if (status === 'ready') return <Redirect href="/(main)/(tabs)" />;
  return null;
}
