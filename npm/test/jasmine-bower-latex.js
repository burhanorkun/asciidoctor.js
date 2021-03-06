var concat = require('../concat.js');
var Log = require('../log.js');
var log = new Log();
var Jasmine = require('jasmine');

log.title('Jasmine Bower Latex');
concat([
  'node_modules/opal-runtime/src/opal.js',
  'build/asciidoctor-extensions.js',
  'build/asciidoctor-latex.js',
  'spec/share/latex-specs.js',
  'spec/bower/bower.spec.js'
], 'build/bower.spec.latex.all.js');

var jasmine = new Jasmine();
jasmine.loadConfig({
  spec_dir: 'build',
  spec_files: [
    'bower.spec.latex.all.js'
  ]
});

// This code is necessary to fake a browser for Opal
//--------------------------------------------------
window = {};

if (typeof XMLHttpRequest === 'undefined') {
  XMLHttpRequest = require('xmlhttprequest').XMLHttpRequest;
  // Define overrideMimeType, not define by default in wrapper
  XMLHttpRequest.prototype.overrideMimeType = function() {};
}
//--------------------------------------------------

jasmine.execute();
