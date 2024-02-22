// zoteroocr.js

// See https://developer.mozilla.org/en-US/docs/Mozilla/JavaScript_code_modules.
Components.utils.import("resource://gre/modules/FileUtils.jsm");
Components.utils.import("resource://gre/modules/osfile.jsm");


ZoteroOCR = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	addedElementIDs: [],
	
	init({ id, version, rootURI }) {
		if (this.initialized) return;
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.initialized = true;
	},
	
	log(msg) {
		Zotero.debug("ZoteroOCR: " + msg);
	},
	
	addToWindow(window) {
		let doc = window.document;
		
		// Add a stylesheet to the main Zotero pane
		let link1 = doc.createElement('link');
		link1.id = 'make-it-red-stylesheet';
		link1.type = 'text/css';
		link1.rel = 'stylesheet';
		link1.href = this.rootURI + 'style.css';
		doc.documentElement.appendChild(link1);
		this.storeAddedElement(link1);
		
		// Use Fluent for localization
		window.MozXULElement.insertFTLIfNeeded("zotero-ocr.ftl");
		
		// Add menu option
		let menuitem = doc.createXULElement('menuitem');
		menuitem.id = 'ocr-selected-pdfs';
		menuitem.setAttribute('type', 'checkbox');
		menuitem.setAttribute('data-l10n-id', 'ocr-selected-pdfs');
		// MozMenuItem#checked is available in Zotero 7
		menuitem.addEventListener('command', () => {
			//ZoteroOCR.toggleGreen(window, menuitem.checked);
			ZoteroOCR.recognize();
		});
		doc.getElementById('menu_ToolsPopup').appendChild(menuitem);
		this.storeAddedElement(menuitem);
	},
	
	addToAllWindows() {
		var windows = Zotero.getMainWindows();
		for (let win of windows) {
			if (!win.ZoteroPane) continue;
			this.addToWindow(win);
		}
	},
	
	storeAddedElement(elem) {
		if (!elem.id) {
			throw new Error("Element must have an id");
		}
		this.addedElementIDs.push(elem.id);
	},
	
	removeFromWindow(window) {
		var doc = window.document;
		// Remove all elements added to DOM
		for (let id of this.addedElementIDs) {
			doc.getElementById(id)?.remove();
		}
		doc.querySelector('[href="zotero-ocr.ftl"]').remove();
	},
	
	removeFromAllWindows() {
		var windows = Zotero.getMainWindows();
		for (let win of windows) {
			if (!win.ZoteroPane) continue;
			this.removeFromWindow(win);
		}
	},
	
	toggleGreen(window, enabled) {
		window.document.documentElement
			.toggleAttribute('data-green-instead', enabled);
	},
	
	async recognize() {

		// Look for the tesseract executable in the settings and at commonly used locations.
		// If it is found, the settings are updated.
		// Otherwise abort with an alert.
		let ocrEngine = Zotero.Prefs.get("zoteroocr.ocrPath");
		let found = false;
		if (ocrEngine) {
			let pathOrFile = FileUtils.File(ocrEngine);
			// If a directory is given, then try for the standard name of the tool.
			if (pathOrFile.isDirectory()) {
				if (Zotero.isWin) {
					ocrEngine = OS.Path.join(ocrEngine, "tesseract.exe");
				}
				else {
					ocrEngine = OS.Path.join(ocrEngine, "tesseract");
				}
				Zotero.Prefs.set("zoteroocr.ocrPath", ocrEngine);
			}
			found = await OS.File.exists(ocrEngine);
		}
		else {
			let path = ["", "/usr/local/bin/", "/usr/bin/", "C:\\Program Files\\Tesseract-OCR\\", "/opt/homebrew/bin/", "/usr/local/homebrew/bin/"];
			for (ocrEngine of path) {
				ocrEngine += "tesseract";
				if (Zotero.isWin) {
					ocrEngine += ".exe";
				}
				if (await OS.File.exists(ocrEngine)) {
					found = true;
					Zotero.debug("Found " + ocrEngine);
					Zotero.Prefs.set("zoteroocr.ocrPath", ocrEngine);
					break;
				}
				Zotero.debug("No " + ocrEngine);
			}
		}
		if (!found) {
			alert("Tesseract executable not found. Tried: " + ocrEngine);
			return;
		}

		// Use the special pdfinfo variant in the zotero directory (which comes along Zotero)
		// See https://developer.mozilla.org/en-US/docs/Archive/Add-ons/Code_snippets/File_I_O#Getting_special_files
		// and https://dxr.mozilla.org/mozilla-central/source/xpcom/io/nsDirectoryServiceDefs.h.
		let zdir = FileUtils.getDir('GreBinD', []);
		let pdfinfo = zdir.clone();
		pdfinfo.append("pdfinfo");
		pdfinfo = pdfinfo.path;
		if (Zotero.isWin) {
			pdfinfo = pdfinfo + ".exe";
		}
		if (! (await OS.File.exists(pdfinfo)) ) {
			alert("No " + pdfinfo + " executable found.");
			return;
		}

		// Look for a specific path in the preferences for pdftoppm
		let pdftoppm = Zotero.Prefs.get("zoteroocr.pdftoppmPath");
		if (!pdftoppm) {
			// alternatively use the also the Zotero directory to look for pdftoppm
			pdftoppm = zdir.clone();
			pdftoppm.append("pdftoppm");
			pdftoppm = pdftoppm.path;
		}
		if (Zotero.isWin && !(pdftoppm.endsWith(".exe"))) {
			pdftoppm = pdftoppm + ".exe";
		}
		if (!(await OS.File.exists(pdftoppm))) {
			alert("No " + pdftoppm + " executable found.");
			return;
		}

		let items = Zotero.getActiveZoteroPane().getSelectedItems();
		for (let item of items) {
			// find the PDF
			let pdfItem;
			if (item.isAttachment()) {
				if (item.isFileAttachment() && item.attachmentContentType == 'application/pdf') {
					pdfItem = item;
					item = Zotero.Items.get(item.parentItemID);
				}
				else {
					alert("Item is attachment but not PDF and will be ignored.");
					continue;
				}
			}
			else {
				let pdfAttachments = item.getAttachments(false)
					.map(itemID => Zotero.Items.get(itemID))
					.filter(att => att.isFileAttachment() && att.attachmentContentType == 'application/pdf');
				if (pdfAttachments.length == 0) {
					alert("No PDF found for the selected item.");
					continue;
				}
				if (pdfAttachments.length > 1) {
					alert("There are several PDFs attached to this item. Only the first one will be processed.");
				}
				pdfItem = pdfAttachments[0];
			}
			let pdf = pdfItem.getFilePath();
			let base = pdf.replace(/\.pdf$/, '');
			let dir = OS.Path.dirname(pdf);
			let infofile = dir + '/pdfinfo.txt';
			let ocrbase = Zotero.Prefs.get("zoteroocr.overwritePDF") ? base : base + '.ocr';
			// TODO filter out PDFs which have already a text layer

			// extract images from PDF
			let imageList = OS.Path.join(dir, 'image-list.txt');
			if (!(await OS.File.exists(imageList))) {
				try {
					Zotero.debug("Running " + pdfinfo + ' ' + pdf + ' ' + infofile);
					await Zotero.Utilities.Internal.exec(pdfinfo, [pdf, infofile]);
					Zotero.debug("Running " + pdftoppm + ' -png -r 300 ' + pdf + ' ' + dir + '/page');
					await Zotero.Utilities.Internal.exec(pdftoppm, ['-png', '-r', 300, pdf, dir + '/page']);
				}
				catch (e) {
					Zotero.logError(e);
				}
				// save the list of images in a separate file
				let info = await Zotero.File.getContentsAsync(infofile);
				let numPages = info.match('Pages:[^0-9]+([0-9]+)')[1];
				var imageListArray = [];
				for (let i = 1; i <= parseInt(numPages, 10); i++) {
					let paddedIndex = "0".repeat(numPages.length) + i;
					imageListArray.push(dir + '/page-' + paddedIndex.substr(-numPages.length) + '.png');
				}
				Zotero.File.putContents(Zotero.File.pathToFile(imageList), imageListArray.join('\n'));
			}

			let parameters = [dir + '/image-list.txt'];
			parameters.push(ocrbase);
			if (Zotero.Prefs.get("zoteroocr.language")) {
				parameters.push('-l');
				parameters.push(Zotero.Prefs.get("zoteroocr.language"));
			}
			parameters.push('txt');
			if (Zotero.Prefs.get("zoteroocr.outputPDF")) {
				parameters.push('pdf');
			}
			if (Zotero.Prefs.get("zoteroocr.outputHocr")) {
				parameters.push('hocr');
			}
			try {
				Zotero.debug("Running " + ocrEngine + ' ' + parameters.join(' '));
				await Zotero.Utilities.Internal.exec(ocrEngine, parameters);
			}
			catch (e) {
				Zotero.logError(e);
			}

			if (Zotero.Prefs.get("zoteroocr.outputNote")) {
				let contents = await Zotero.File.getContentsAsync(ocrbase + '.txt');
				contents = contents.replace(/(?:\r\n|\r|\n)/g, '<br />');
				let newNote = new Zotero.Item('note');
				newNote.setNote(contents);
				newNote.parentID = item.id;
				await newNote.saveTx();
			}
			
			
			if (Zotero.Prefs.get("zoteroocr.outputHocr")) {
				let contents = await Zotero.File.getContentsAsync(ocrbase + '.hocr');
				// replace the absolute paths of images with relative ones
				let escapedDir = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				let regexp = new RegExp(escapedDir + "/", 'g');
				contents = contents.replace(regexp, '');
				// split content into the preamble and pages
				contents = contents.replace("</body>\n</html>", '');
				let parts = contents.split("<div class='ocr_page'");
				let preamble = parts[0];
				// create new html attachments including hocrjs for individual pages
				let maximumPagesAsHtml = parseInt(Zotero.Prefs.get("zoteroocr.maximumPagesAsHtml"));
				let upperLimit = parts.length;
				if (!(isNaN(maximumPagesAsHtml)) && (maximumPagesAsHtml + 1 < upperLimit)) {
					upperLimit = maximumPagesAsHtml + 1;
				}
				for (let i = 1; i < upperLimit; i++) {
					let pagename = 'page-' + i + '.html';
					let htmlfile = Zotero.File.pathToFile(OS.Path.join(dir, pagename));
					let pagecontent = preamble + "<div class='ocr_page'" + parts[i] +	'<script src="https://unpkg.com/hocrjs"></script>\n</body>\n</html>';
					Zotero.File.putContents(htmlfile, pagecontent);
					await Zotero.Attachments.linkFromFile({
						file: OS.Path.join(dir, pagename),
						contentType: "text/html",
						parentItemID: item.id
					});
				}
			}

			// attach PDF if it is a new one
			if (Zotero.Prefs.get("zoteroocr.outputPDF") && !(Zotero.Prefs.get("zoteroocr.overwritePDF"))) {
				await Zotero.Attachments.linkFromFile({
					file: ocrbase + '.pdf',
					parentItemID: item.id
				});
			}
			
			if (!Zotero.Prefs.get("zoteroocr.outputPNG") && imageListArray) {
				// delete image list
				await Zotero.File.removeIfExists(imageList);
				// delete PNGs
				for (let imageName of imageListArray) {
					await Zotero.File.removeIfExists(imageName);
				}
			}
		}
	},
	
	async main() {
		// Global properties are included automatically in Zotero 7
		var host = new URL('https://foo.com/path').host;
		this.log(`Host is ${host}`);
		
		// Retrieve a global pref
		this.log(`Intensity is ${Zotero.Prefs.get('extensions.make-it-red.intensity', true)}`);
	},
};