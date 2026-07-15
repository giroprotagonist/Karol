package com.karol.controller

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Size
import android.view.View
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class QrScanActivity : AppCompatActivity() {
	private lateinit var previewView: PreviewView
	private lateinit var hintText: TextView
	private lateinit var cancelButton: Button
	private lateinit var cameraExecutor: ExecutorService
	private val hasScanned = AtomicBoolean(false)

	private val requestCameraPermission =
		registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
			if (granted) {
				startCamera()
			} else {
				Toast.makeText(this, R.string.camera_permission_required, Toast.LENGTH_LONG)
					.show()
				finish()
			}
		}

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		setContentView(R.layout.activity_qr_scan)

		previewView = findViewById(R.id.previewView)
		hintText = findViewById(R.id.qrHintText)
		cancelButton = findViewById(R.id.cancelScanButton)
		cameraExecutor = Executors.newSingleThreadExecutor()

		cancelButton.setOnClickListener { finish() }

		if (hasCameraPermission()) {
			startCamera()
		} else {
			requestCameraPermission.launch(Manifest.permission.CAMERA)
		}
	}

	private fun hasCameraPermission(): Boolean {
		return ContextCompat.checkSelfPermission(
			this,
			Manifest.permission.CAMERA,
		) == PackageManager.PERMISSION_GRANTED
	}

	private fun startCamera() {
		val cameraProviderFuture = ProcessCameraProvider.getInstance(this)
		cameraProviderFuture.addListener(
			{
				val cameraProvider = cameraProviderFuture.get()
				val preview = Preview.Builder().build().also {
					it.surfaceProvider = previewView.surfaceProvider
				}
				val analyzer = ImageAnalysis.Builder()
					.setTargetResolution(Size(1280, 720))
					.setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
					.build()
				val scanner = BarcodeScanning.getClient()
				analyzer.setAnalyzer(cameraExecutor) { imageProxy ->
					if (hasScanned.get()) {
						imageProxy.close()
						return@setAnalyzer
					}
					@Suppress("UnsafeOptInUsageError")
					val mediaImage = imageProxy.image
					if (mediaImage == null) {
						imageProxy.close()
						return@setAnalyzer
					}
					val image = InputImage.fromMediaImage(
						mediaImage,
						imageProxy.imageInfo.rotationDegrees,
					)
					scanner.process(image)
						.addOnSuccessListener { barcodes ->
							for (barcode in barcodes) {
								if (barcode.format != Barcode.FORMAT_QR_CODE) continue
								val raw = barcode.rawValue ?: continue
								val url = KarolUrl.normalize(raw) ?: continue
								if (!hasScanned.compareAndSet(false, true)) return@addOnSuccessListener
								runOnUiThread { finishWithUrl(url) }
								return@addOnSuccessListener
							}
						}
						.addOnCompleteListener { imageProxy.close() }
				}
				cameraProvider.unbindAll()
				cameraProvider.bindToLifecycle(
					this,
					CameraSelector.DEFAULT_BACK_CAMERA,
					preview,
					analyzer,
				)
				hintText.visibility = View.VISIBLE
			},
			ContextCompat.getMainExecutor(this),
		)
	}

	private fun finishWithUrl(url: String) {
		setResult(
			RESULT_OK,
			Intent().putExtra(EXTRA_URL, url),
		)
		finish()
	}

	override fun onDestroy() {
		super.onDestroy()
		cameraExecutor.shutdown()
	}

	companion object {
		const val EXTRA_URL = "karol_controller_url"
	}
}
