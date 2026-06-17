import 'dart:convert';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';

class PortfolioCsvSelection {
  const PortfolioCsvSelection({required this.fileName, required this.rawCsv});

  final String fileName;
  final String rawCsv;
}

abstract interface class PortfolioCsvLoader {
  const PortfolioCsvLoader();

  Future<PortfolioCsvSelection?> pickCsv();
}

class FilePickerPortfolioCsvLoader implements PortfolioCsvLoader {
  const FilePickerPortfolioCsvLoader();

  @override
  Future<PortfolioCsvSelection?> pickCsv() async {
    final result = await FilePicker.pickFiles(
      allowMultiple: false,
      type: FileType.custom,
      allowedExtensions: const ['csv'],
      withData: true,
    );
    if (result == null || result.files.isEmpty) {
      return null;
    }

    final file = result.files.single;
    return PortfolioCsvSelection(
      fileName: file.name,
      rawCsv: await _readRawCsv(file),
    );
  }

  Future<String> _readRawCsv(PlatformFile file) async {
    final bytes = file.bytes;
    if (bytes != null) {
      return _decodeBytes(bytes);
    }
    return file.xFile.readAsString();
  }

  String _decodeBytes(Uint8List bytes) {
    try {
      return utf8.decode(bytes);
    } on FormatException {
      return latin1.decode(bytes);
    }
  }
}
