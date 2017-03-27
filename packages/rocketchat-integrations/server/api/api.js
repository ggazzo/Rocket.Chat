/* globals Api Meteor Restivus logger processWebhookMessage*/
// TODO: remove globals
const vm = Npm.require('vm');

import moment from 'moment';

const compiledScripts = {};

const buildSandbox = function(store) {
	if (store == null) {
		store = {};
	}
	const sandbox = {
		_,
		s,
		console,
		moment,
		Store: {
			set(key, val) {
				return store[key] = val;
			},
			get(key) {
				return store[key];
			}
		},
		HTTP(method, url, options) {
			try {
				return {
					result: HTTP.call(method, url, options)
				};
			} catch (error) {
				return {
					error
				};
			}
		}
	};

	Object.keys(RocketChat.models).filter(function(k) {
		return !k.startsWith('_');
	}).forEach((k) => {
		return sandbox[k] = RocketChat.models[k];
	});
	return { store, sandbox	};
};

const getIntegrationScript = function(integration) {
	const compiledScript = compiledScripts[integration._id];
	if ((compiledScript != null) && +compiledScript._updatedAt === +integration._updatedAt) {
		return compiledScript.script;
	}
	const script = integration.scriptCompiled;
	let vmScript = null;
	const sandboxItems = buildSandbox();
	try {
		logger.incoming.info('Will evaluate script of Trigger', integration.name);
		logger.incoming.debug(script);
		vmScript = vm.createScript(script, 'script.js');
		vmScript.runInNewContext(sandboxItems.sandbox);
		if (sandboxItems.sandbox.Script != null) {
			compiledScripts[integration._id] = {
				script: new sandboxItems.sandbox.Script(),
				store: sandboxItems.store,
				_updatedAt: integration._updatedAt
			};
			return compiledScripts[integration._id].script;
		}
	} catch ({stack}) {
		logger.incoming.error('[Error evaluating Script in Trigger', integration.name, ':]');
		logger.incoming.error(script.replace(/^/gm, '  '));
		logger.incoming.error('[Stack:]');
		logger.incoming.error(stack.replace(/^/gm, '  '));
		throw RocketChat.API.v1.failure('error-evaluating-script');
	}
	if (sandboxItems.sandbox.Script == null) {
		logger.incoming.error('[Class "Script" not in Trigger', integration.name, ']');
		throw RocketChat.API.v1.failure('class-script-not-found');
	}
};

Api = new Restivus({
	enableCors: true,
	apiPath: 'hooks/',
	auth: {
		user() {
			const payloadKeys = Object.keys(this.bodyParams);
			const payloadIsWrapped = (this.bodyParams && this.bodyParams.payload) && payloadKeys.length === 1;
			if (payloadIsWrapped && this.request.headers['content-type'] === 'application/x-www-form-urlencoded') {
				try {
					this.bodyParams = JSON.parse(this.bodyParams.payload);
				} catch ({message}) {
					return {
						error: {
							statusCode: 400,
							body: {
								success: false,
								error: message
							}
						}
					};
				}
			}
			this.integration = RocketChat.models.Integrations.findOne({
				_id: this.request.params.integrationId,
				token: decodeURIComponent(this.request.params.token)
			});
			if (this.integration == null) {
				logger.incoming.info('Invalid integration id', this.request.params.integrationId, 'or token', this.request.params.token);
				return;
			}
			const user = RocketChat.models.Users.findOne({
				_id: this.integration.userId
			});
			return {user};
		}
	}
});

const createIntegration = function(options, user) {
	logger.incoming.info('Add integration', options.name);
	logger.incoming.debug(options);
	Meteor.runAsUser(user._id, function() {
		switch (options['event']) {
			case 'newMessageOnChannel':
				if (options.data == null) {
					options.data = {};
				}
				if ((options.data.channel_name != null) && options.data.channel_name.indexOf('#') === -1) {
					options.data.channel_name = `#${ options.data.channel_name }`;
				}
				return Meteor.call('addOutgoingIntegration', {
					username: 'rocket.cat',
					urls: [options.target_url],
					name: options.name,
					channel: options.data.channel_name,
					triggerWords: options.data.trigger_words
				});
			case 'newMessageToUser':
				if (options.data.username.indexOf('@') === -1) {
					options.data.username = `@${ options.data.username }`;
				}
				return Meteor.call('addOutgoingIntegration', {
					username: 'rocket.cat',
					urls: [options.target_url],
					name: options.name,
					channel: options.data.username,
					triggerWords: options.data.trigger_words
				});
		}
	});
	return RocketChat.API.v1.success();
};

const removeIntegration = function(options, user) {
	logger.incoming.info('Remove integration');
	logger.incoming.debug(options);
	const integrationToRemove = RocketChat.models.Integrations.findOne({
		urls: options.target_url
	});
	Meteor.runAsUser(user._id, () => {
		return Meteor.call('deleteOutgoingIntegration', integrationToRemove._id);
	});
	return RocketChat.API.v1.success();
};

const executeIntegrationRest = function() {
	logger.incoming.info('Post integration:', this.integration.name);
	logger.incoming.debug('@urlParams:', this.urlParams);
	logger.incoming.debug('@bodyParams:', this.bodyParams);
	if (this.integration.enabled !== true) {
		return {
			statusCode: 503,
			body: 'Service Unavailable'
		};
	}
	const defaultValues = {
		channel: this.integration.channel,
		alias: this.integration.alias,
		avatar: this.integration.avatar,
		emoji: this.integration.emoji
	};
	if (this.integration.scriptEnabled === true && (this.integration.scriptCompiled != null) && this.integration.scriptCompiled.trim() !== '') {
		let script;
		try {
			script = getIntegrationScript(this.integration);
		} catch (error) {
			const e = error;
			logger.incoming.warn(e);
			return RocketChat.API.v1.failure(e.message);
		}
		const request = {
			url: {
				hash: this.request._parsedUrl.hash,
				search: this.request._parsedUrl.search,
				query: this.queryParams,
				pathname: this.request._parsedUrl.pathname,
				path: this.request._parsedUrl.path
			},
			url_raw: this.request.url,
			url_params: this.urlParams,
			content: this.bodyParams,
			content_raw: this.request._readableState && this.request._readableState.buffer && this.request._readableState.buffer.toString(),
			headers: this.request.headers,
			user: {
				_id: this.user._id,
				name: this.user.name,
				username: this.user.username
			}
		};
		try {
			const sandboxItems = buildSandbox(compiledScripts[this.integration._id].store);
			const sandbox = sandboxItems.sandbox;
			sandbox.script = script;
			sandbox.request = request;
			const result = vm.runInNewContext('script.process_incoming_request({ request: request })', sandbox, {
				timeout: 3000
			});
			if (result && result.console.error) {
				return RocketChat.API.v1.failure(result.error);
			}
			this.bodyParams = result != null ? result.content : null;
			logger.incoming.debug('[Process Incoming Request result of Trigger', this.integration.name, ':]');
			logger.incoming.debug('result', this.bodyParams);
		} catch (error) {
			const e = error;
			logger.incoming.error('[Error running Script in Trigger', this.integration.name, ':]');
			logger.incoming.error(this.integration.scriptCompiled.replace(/^/gm, '  '));
			logger.incoming.error('[Stack:]');
			logger.incoming.error(e.stack.replace(/^/gm, '  '));
			return RocketChat.API.v1.failure('error-running-script');
		}
	}
	if (this.bodyParams == null) {
		return RocketChat.API.v1.failure('body-empty');
	}
	this.bodyParams.bot = {
		i: this.integration._id
	};
	try {
		const message = processWebhookMessage(this.bodyParams, this.user, defaultValues);
		if (_.isEmpty(message)) {
			return RocketChat.API.v1.failure('unknown-error');
		}
		return RocketChat.API.v1.success();
	} catch (error) {
		const e = error;
		return RocketChat.API.v1.failure(e.error);
	}
};

const addIntegrationRest = function() {
	return createIntegration(this.bodyParams, this.user);
};

const removeIntegrationRest = function() {
	return removeIntegration(this.bodyParams, this.user);
};

const integrationSampleRest = function() {
	logger.incoming.info('Sample Integration');
	return {
		statusCode: 200,
		body: [
			{
				token: Random.id(24),
				channel_id: Random.id(),
				channel_name: 'general',
				timestamp: new Date,
				user_id: Random.id(),
				user_name: 'rocket.cat',
				text: 'Sample text 1',
				trigger_word: 'Sample'
			}, {
				token: Random.id(24),
				channel_id: Random.id(),
				channel_name: 'general',
				timestamp: new Date,
				user_id: Random.id(),
				user_name: 'rocket.cat',
				text: 'Sample text 2',
				trigger_word: 'Sample'
			}, {
				token: Random.id(24),
				channel_id: Random.id(),
				channel_name: 'general',
				timestamp: new Date,
				user_id: Random.id(),
				user_name: 'rocket.cat',
				text: 'Sample text 3',
				trigger_word: 'Sample'
			}
		]
	};
};

const integrationInfoRest = function() {
	logger.incoming.info('Info integration');
	return {
		statusCode: 200,
		body: {
			success: true
		}
	};
};

Api.addRoute(':integrationId/:userId/:token', {
	authRequired: true
}, {
	post: executeIntegrationRest,
	get: executeIntegrationRest
});

Api.addRoute(':integrationId/:token', {
	authRequired: true
}, {
	post: executeIntegrationRest,
	get: executeIntegrationRest
});

Api.addRoute('sample/:integrationId/:userId/:token', {
	authRequired: true
}, {
	get: integrationSampleRest
});

Api.addRoute('sample/:integrationId/:token', {
	authRequired: true
}, {
	get: integrationSampleRest
});

Api.addRoute('info/:integrationId/:userId/:token', {
	authRequired: true
}, {
	get: integrationInfoRest
});

Api.addRoute('info/:integrationId/:token', {
	authRequired: true
}, {
	get: integrationInfoRest
});

Api.addRoute('add/:integrationId/:userId/:token', {
	authRequired: true
}, {
	post: addIntegrationRest
});

Api.addRoute('add/:integrationId/:token', {
	authRequired: true
}, {
	post: addIntegrationRest
});

Api.addRoute('remove/:integrationId/:userId/:token', {
	authRequired: true
}, {
	post: removeIntegrationRest
});

Api.addRoute('remove/:integrationId/:token', {
	authRequired: true
}, {
	post: removeIntegrationRest
});
