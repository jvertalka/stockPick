import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

class AppTheme {
  static const Color background = Color(0xFF08131E);
  static const Color backgroundAccent = Color(0xFF12263A);
  static const Color surface = Color(0xFF132538);
  static const Color surfaceAlt = Color(0xFF193149);
  static const Color mint = Color(0xFF6AE3C5);
  static const Color amber = Color(0xFFF5C86B);
  static const Color coral = Color(0xFFF27C73);
  static const Color sky = Color(0xFF7DB7FF);
  static const Color textPrimary = Color(0xFFF4F7FB);
  static const Color textMuted = Color(0xFFA8B8CB);

  static ThemeData build() {
    const colorScheme = ColorScheme.dark(
      primary: mint,
      secondary: amber,
      surface: surface,
      error: coral,
      onPrimary: Color(0xFF04111A),
      onSecondary: Color(0xFF201607),
      onSurface: textPrimary,
      onError: textPrimary,
    );

    final base = ThemeData(
      useMaterial3: true,
      colorScheme: colorScheme,
      scaffoldBackgroundColor: background,
      brightness: Brightness.dark,
    );

    final bodyTheme = GoogleFonts.plusJakartaSansTextTheme(base.textTheme);
    final displayTheme = GoogleFonts.spaceGroteskTextTheme(bodyTheme);

    return base.copyWith(
      textTheme: displayTheme.copyWith(
        displayLarge: GoogleFonts.spaceGrotesk(
          fontSize: 46,
          fontWeight: FontWeight.w700,
          color: textPrimary,
        ),
        displayMedium: GoogleFonts.spaceGrotesk(
          fontSize: 36,
          fontWeight: FontWeight.w700,
          color: textPrimary,
        ),
        headlineLarge: GoogleFonts.spaceGrotesk(
          fontSize: 28,
          fontWeight: FontWeight.w700,
          color: textPrimary,
        ),
        headlineMedium: GoogleFonts.spaceGrotesk(
          fontSize: 22,
          fontWeight: FontWeight.w700,
          color: textPrimary,
        ),
        titleLarge: GoogleFonts.spaceGrotesk(
          fontSize: 18,
          fontWeight: FontWeight.w700,
          color: textPrimary,
        ),
        titleMedium: GoogleFonts.plusJakartaSans(
          fontSize: 15,
          fontWeight: FontWeight.w700,
          color: textPrimary,
        ),
        bodyLarge: GoogleFonts.plusJakartaSans(
          fontSize: 16,
          color: textPrimary,
          height: 1.45,
        ),
        bodyMedium: GoogleFonts.plusJakartaSans(
          fontSize: 14,
          color: textMuted,
          height: 1.5,
        ),
        bodySmall: GoogleFonts.plusJakartaSans(
          fontSize: 12,
          color: textMuted,
          height: 1.45,
        ),
        labelLarge: GoogleFonts.plusJakartaSans(
          fontSize: 13,
          fontWeight: FontWeight.w700,
          color: textPrimary,
        ),
      ),
      dividerColor: Colors.white.withValues(alpha: 0.08),
      cardColor: surface,
      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: surface.withValues(alpha: 0.94),
        indicatorColor: mint.withValues(alpha: 0.16),
        labelTextStyle: WidgetStateProperty.all(
          GoogleFonts.plusJakartaSans(
            fontSize: 12,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
      navigationRailTheme: NavigationRailThemeData(
        backgroundColor: surface.withValues(alpha: 0.72),
        indicatorColor: mint.withValues(alpha: 0.16),
        selectedIconTheme: const IconThemeData(color: mint),
        unselectedIconTheme: IconThemeData(
          color: textMuted.withValues(alpha: 0.9),
        ),
        selectedLabelTextStyle: GoogleFonts.plusJakartaSans(
          color: textPrimary,
          fontWeight: FontWeight.w700,
        ),
        unselectedLabelTextStyle: GoogleFonts.plusJakartaSans(
          color: textMuted,
          fontWeight: FontWeight.w600,
        ),
      ),
      chipTheme: base.chipTheme.copyWith(
        backgroundColor: surfaceAlt,
        side: BorderSide(color: Colors.white.withValues(alpha: 0.08)),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: mint,
          foregroundColor: background,
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
          ),
          textStyle: GoogleFonts.plusJakartaSans(
            fontSize: 13,
            fontWeight: FontWeight.w700,
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: textPrimary,
          side: BorderSide(color: Colors.white.withValues(alpha: 0.12)),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(16),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
        ),
      ),
    );
  }

  static const LinearGradient backgroundGradient = LinearGradient(
    colors: [
      Color(0xFF07111A),
      Color(0xFF0B1723),
      Color(0xFF0E2132),
      Color(0xFF13283B),
    ],
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
  );
}
