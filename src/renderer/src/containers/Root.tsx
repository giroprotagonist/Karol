import { FocusStyleManager } from '@blueprintjs/core';
import { SettingsProvider } from './SettingsProvider';
import HomePage from '@renderer/containers/HomePage';
import { initYoutubeDjRemoteBridge } from '@renderer/features/YouTubeKaraoke/youtubeDjRemoteBridge';

FocusStyleManager.onlyShowFocusOnTabs();
initYoutubeDjRemoteBridge();

const Root = () => {
	return (
		<SettingsProvider>
			<HomePage />
		</SettingsProvider>
	);
};

export default Root;
