import React, { useCallback, useEffect, useState } from 'react';
import { Classes } from '@blueprintjs/core';
import { ToastProvider, DefaultToast, useToasts } from 'react-toast-notifications';
import { useTranslation } from 'react-i18next';

import { LIGHT_UI_BACKGROUND } from './SettingsProvider';
import DeskreenStepper from './DeskreenStepper';
import { Device } from '../../../common/Device';
import TopPanel from '@renderer/components/TopPanel';
import { IpcEvents } from '../../../common/IpcEvents.enum';
import YouTubeKaraokePanel from '@renderer/components/YouTubeKaraokePanel/YouTubeKaraokePanel';

// @ts-ignore: it is ok here, be like js it is fine
// eslint-disable-next-line react/prop-types
export const CustomToastWithTheme = ({
	children,
	...props
}): React.ReactElement => {
	return (
		<DefaultToast
			components={{ Toast: CustomToastWithTheme }}
			{...props}
			// @ts-ignore: some minor type complain, it is fine here
			style={{
				color: '#293742',
				backgroundColor: LIGHT_UI_BACKGROUND,
			}}
		>
			<>{children}</>
		</DefaultToast>
	);
};

async function disconnectAllActiveSharingSessions(): Promise<void> {
	const devices: Device[] = await window.electron.ipcRenderer.invoke(
		IpcEvents.GetConnectedDevices,
	);
	await Promise.all(
		devices.map((device) =>
			window.electron.ipcRenderer.invoke(
				IpcEvents.DisconnectPeerAndDestroySharingSessionBySessionID,
				device.sharingSessionID,
			),
		),
	);
}

function RemoteControlSessionListener(): null {
	const { addToast } = useToasts();
	const { t } = useTranslation();

	useEffect(() => {
		const handleRemoteControlActive = (): void => {
			addToast(t('tablet-control-active'), {
				appearance: 'warning',
				autoDismiss: false,
			});
		};

		window.electron.ipcRenderer.on(
			IpcEvents.RemoteControlSessionActive,
			handleRemoteControlActive,
		);

		return () => {
			window.electron.ipcRenderer.removeListener(
				IpcEvents.RemoteControlSessionActive,
				handleRemoteControlActive,
			);
		};
	}, [addToast, t]);

	return null;
}

export default function HomePage(): React.ReactElement {
	console.log('window.api', window.api);
	const [activeStep, setActiveStep] = useState(0);
	const [isAllowDeviceAlertOpen, setIsAllowDeviceAlertOpen] = useState(false);
	const [isUserAllowedConnection, setIsUserAllowedConnection] = useState(false);
	const [pendingConnectionDevice, setPendingConnectionDevice] =
		useState<Device | null>(null);
	const [isCastingActive, setIsCastingActive] = useState(false);

	const syncCastingState = useCallback(async (): Promise<void> => {
		const devices: Device[] = await window.electron.ipcRenderer.invoke(
			IpcEvents.GetConnectedDevices,
		);
		setIsCastingActive(devices.length > 0);
	}, []);

	useEffect(() => {
		void syncCastingState();

		const handleAvailabilityChange = (
			_: unknown,
			payload: { isAvailable: boolean },
		): void => {
			if (!payload?.isAvailable) {
				setIsCastingActive(true);
				return;
			}
			void syncCastingState();
		};

		window.electron.ipcRenderer.on(
			IpcEvents.ViewerConnectionAvailabilityChanged,
			handleAvailabilityChange,
		);

		return () => {
			window.electron.ipcRenderer.removeListener(
				IpcEvents.ViewerConnectionAvailabilityChanged,
				handleAvailabilityChange,
			);
		};
	}, [syncCastingState]);

	const handleSharingStarted = useCallback((): void => {
		setIsCastingActive(true);
		setActiveStep(0);
		setPendingConnectionDevice(null);
		setIsUserAllowedConnection(false);
		setIsAllowDeviceAlertOpen(false);
	}, []);

	const handleResetWithSharingSessionRestart =
		useCallback(async (): Promise<void> => {
			await disconnectAllActiveSharingSessions();
			setIsCastingActive(false);
			setActiveStep(0);
			setPendingConnectionDevice(null);
			setIsUserAllowedConnection(false);
			setIsAllowDeviceAlertOpen(false);

			await window.electron.ipcRenderer.invoke(
				IpcEvents.ResetWaitingForConnectionSharingSession,
			);
			await window.electron.ipcRenderer.invoke(
				IpcEvents.CreateWaitingForConnectionSharingSession,
			);
		}, []);

	return (
		<ToastProvider
			placement="top-center"
			autoDismissTimeout={5000}
			components={{ Toast: CustomToastWithTheme }}
		>
			<RemoteControlSessionListener />
			<div className={Classes.TREE}>
				<TopPanel handleReset={handleResetWithSharingSessionRestart} />
				<YouTubeKaraokePanel />
				<DeskreenStepper
					activeStep={activeStep}
					setActiveStep={setActiveStep}
					isAllowDeviceAlertOpen={isAllowDeviceAlertOpen}
					setIsAllowDeviceAlertOpen={setIsAllowDeviceAlertOpen}
					isUserAllowedConnection={isUserAllowedConnection}
					setIsUserAllowedConnection={setIsUserAllowedConnection}
					pendingConnectionDevice={pendingConnectionDevice}
					setPendingConnectionDevice={setPendingConnectionDevice}
					handleReset={handleResetWithSharingSessionRestart}
					isCastingActive={isCastingActive}
					onSharingStarted={handleSharingStarted}
				/>
			</div>
		</ToastProvider>
	);
}
