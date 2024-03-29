'use babel';
/* @flow */

/*
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 */

var {getClient} = require('nuclide-client');
var {extractWordAtPosition} = require('nuclide-atom-helpers');
var HackLanguage = require('./HackLanguage');
var NullHackClient = require('./NullHackClient');
var logger = require('nuclide-logging').getLogger();
var url = require('url');
var pathUtil = require('path');

const NULL_CONNECTION_ID = 'null';
const HACK_WORD_REGEX = /[a-zA-Z0-9_$]+/g;

/**
 * This is responsible for managing (creating/disposing) multiple HackLanguage instances,
 * creating the designated HackService instances with the NuclideClient it needs per remote project.
 * Also, it deelegates the language feature request to the correct HackLanguage instance.
 */
var clientToHackLanguage: {[clientId: string]: HackLanguage} = {};
/**
 * Map of project id to an array of Hack Service diagnostics
 */
var clientToHackLinterCache: {[clientId: string]: Array<mixed>} = {};

module.exports = {

  async findDiagnostics(editor: TextEditor): Promise<Array<mixed>> {
    var buffer = editor.getBuffer();
    var hackLanguage = await getHackLanguageForBuffer(buffer);
    var {path} = url.parse(editor.getPath());
    var contents = editor.getText();
    var errors = await hackLanguage.getDiagnostics(path, contents);
    var mixedErrors = errors;
    var clientId = getClientId(buffer);
    if (clientToHackLinterCache[clientId]) {
      mixedErrors = errors.concat(clientToHackLinterCache[clientId]);
    }
    return mixedErrors;
  },

  async fetchCompletionsForEditor(editor: TextEditor, prefix: string): Promise<Array<mixed>> {
    var hackLanguage = await getHackLanguageForBuffer(editor.getBuffer());
    var {path} = url.parse(editor.getPath());
    var contents = editor.getText();
    var cursor = editor.getLastCursor();
    var offset = editor.getBuffer().characterIndexForPosition(cursor.getBufferPosition());
    // The returned completions may have unrelated results, even though the offset is set on the end of the prefix.
    var completions = await hackLanguage.getCompletions(path, contents, offset);
    // Filter out the completions that do not contain the prefix as a token in the match text case insentively.
    var tokenLowerCase = prefix.toLowerCase();
    return completions.filter(completion => completion.matchText.toLowerCase().indexOf(tokenLowerCase) >= 0);
  },

  async formatSourceFromEditor(editor: TextEditor, range: Range): Promise<string> {
    var buffer = editor.getBuffer();
    var hackLanguage = await getHackLanguageForBuffer(buffer);
    var startPosition = buffer.characterIndexForPosition(range.start);
    var endPosition = buffer.characterIndexForPosition(range.end);
    return await hackLanguage.formatSource(buffer.getText(), startPosition + 1, endPosition + 1);
  },

  async typeHintFromEditor(editor: TextEditor, position: Point): Promise<TypeHint> {
    var hackLanguage = await getHackLanguageForBuffer(editor.getBuffer());

    var matchData = extractWordAtPosition(editor, position, HACK_WORD_REGEX);
    if (!matchData) {
      return null;
    }

    var {path} = url.parse(editor.getPath());
    var contents = editor.getText();

    var type = await hackLanguage.getType(path, contents, matchData.word, position.row + 1, position.column + 1);
    if (!type) {
      return null;
    } else {
      return {
        hint: type,
        range: matchData.range,
      };
    }
  },

  /**
   * If a location can be found for the declaration, the return value will
   * resolve to an object with these fields: file, line, column.
   */
  async findDefinition(editor: TextEditor, line: number, column: number): Promise<mixed> {
    var hackLanguage = await getHackLanguageForBuffer(editor.getBuffer());
    var {path, protocol, host} = url.parse(editor.getPath());

    var contents = editor.getText();
    var buffer = editor.getBuffer();
    var lineText = buffer.lineForRow(line);
    var result = await hackLanguage.getDefinition(path, contents, line + 1, column + 1, lineText);
    if (!result || !result.length) {
      return null;
    }
    var pos = result[0];
    return {
      file: getFilePath(pos.path, protocol, host),
      line: pos.line - 1,
      column: pos.column - 1,
    };
  },

  async onDidSave(editor: TextEditor): void {
    var {path} = url.parse(editor.getPath());
    var contents = editor.getText();
    var buffer = editor.getBuffer();
    var hackLanguage = await getHackLanguageForBuffer(buffer);

    // Update the HackWorker model with the contents of the file opened or saved.
    await hackLanguage.updateFile(path, contents);

    var diagnostics;
    try {
      diagnostics = await hackLanguage.getServerDiagnostics();
    } catch (err) {
      logger.error('Hack: getServerDiagnostics failed', err);
    }
    if (diagnostics) {
      clientToHackLinterCache[getClientId(buffer)] = diagnostics;
      // Trigger the linter to catch the new diagnostics.
      atom.commands.dispatch(atom.views.getView(editor), 'linter:lint');
    }

    // Fetch any dependencies the HackWorker needs after learning about this file.
    // We don't block any realtime logic on the dependency fetching - it could take a while.
    hackLanguage.updateDependencies();
  },
};

function getFilePath(filePath: string, protocol: ?string, host: ?string): string {
  if (!protocol || !host) {
    return filePath;
  }
  return protocol + '//' + host + filePath;
}

function getClientId(buffer: TextBuffer): string {
  var client = getClient(buffer.getUri());
  return client.getID();
}

function getHackLanguageForBuffer(buffer: TextBuffer): Promise<HackLanguage> {
  var uri = buffer.getUri();
  var {path: filePath} = url.parse(uri);
  var client = getClient(uri);
  return createHackLanguageIfNotExisting(client, filePath);
  // TODO(most): dispose the language/worker on project close.
}

async function createHackLanguageIfNotExisting(client: NuclideClient, filePath: string): Promise<HackLanguage> {
  var clientId = client.getID();
  if (clientToHackLanguage[clientId]) {
    return clientToHackLanguage[clientId];
  }
  var hackClient;
  var [{stdout}, nearestPath] = await Promise.all([
    client.exec('which hh_client'),
    client.findNearestFile('.hhconfig', pathUtil.dirname(filePath)),
  ]);
  // If multiple calls, were done asynchronously, make sure to return the single-created HackLanguage.
  if (clientToHackLanguage[clientId]) {
    return clientToHackLanguage[clientId];
  }
  if (stdout.trim() && nearestPath) {
    hackClient = client;
  } else {
    hackClient = new NullHackClient();
  }
  clientToHackLanguage[clientId] = new HackLanguage(hackClient);
  return clientToHackLanguage[clientId];
}
