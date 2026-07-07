package com.deskreen.player

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter

object QrCodeHelper {
	fun encode(text: String, size: Int = 512): Bitmap? {
		return try {
			val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
			val width = matrix.width
			val height = matrix.height
			val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.RGB_565)
			for (x in 0 until width) {
				for (y in 0 until height) {
					bitmap.setPixel(x, y, if (matrix[x, y]) Color.BLACK else Color.WHITE)
				}
			}
			bitmap
		} catch (_: Exception) {
			null
		}
	}
}
