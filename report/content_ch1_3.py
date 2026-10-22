# -*- coding: utf-8 -*-
"""Report text for chapters 1-3. Block types: ('p', text) | ('img', file, caption) | ('table', caption, header, rows, widths_in) | ('code', text)
Inline markup in paragraphs: **bold**, `code`."""

CH1 = {
    'num': '1', 'title': 'INTRODUCTION',
    'intro': "This chapter deals with the background and the purpose of the project. It introduces the IoT Device Health and Security Monitoring Platform (IoT Sentinel), explains the problem that motivated it, states the objectives that guided the work, describes what is and is not covered, and explains why the work was worth undertaking.",
    'sections': [
        ('1.1', 'OVERVIEW', [
            ('p', "The Internet of Things (IoT) connects sensors, controllers, cameras, meters and industrial machines to networks so that their condition can be observed and acted upon remotely. As the number of connected devices in factories, utilities and buildings grows, the people who look after them must watch an ever larger stream of readings, decide which device needs attention first, keep firmware up to date, react to security events and, at the same time, remember what the maintenance manuals say about each type of machine. Doing this with separate tools, spreadsheets and printed documents is slow and error prone."),
            ('p', "**IoT Sentinel** is a web-based platform that brings these tasks together. Devices (or the built-in simulator) send readings such as temperature, CPU load, memory use, battery level, signal strength, vibration, pressure and motor current to a REST API. The platform stores the readings, compares them with limits that can be set for each machine type, raises alerts when a limit is crossed or a device stops reporting, and uses a small machine-learning model to estimate, before a limit is crossed, the probability that it is about to be crossed. Every prediction is accompanied by an explanation that shows how much each input contributed to the result."),
            ('p', "In addition to monitoring, the platform contains a **Knowledge Base** and an **AI Maintenance Assistant**. Maintenance staff can upload manuals, procedures and inspection reports (PDF, DOCX, TXT, Markdown or CSV). The assistant answers questions in natural language by combining two sources: live data read from the platform through a fixed set of read-only tools, and passages retrieved from the documents the user is allowed to read. Each answer carries verifiable citations, and the assistant never changes any data. A language model that runs locally on the same machine (through Ollama) is used, so no document or reading leaves the installation."),
            ('p', "The system is built with React and TypeScript for the user interface, Node.js with Express.js (TypeScript) for the REST API, MongoDB for operational data (users, devices, telemetry, alerts, rules and history), PostgreSQL with the pgvector extension for the retrieval-augmented generation (RAG) part, Redis for fast shared state and live updates, and Docker for packaging. It provides reports in CSV and PDF form, an audit log of security-relevant actions, and a complete automated test suite."),
        ]),
        ('1.2', 'PROBLEM DEFINITION', [
            ('p', "Organisations that operate connected equipment usually face four related difficulties. First, monitoring is **reactive**: most dashboards only alert after a fixed threshold has already been crossed, which leaves little time to act. Second, **context is scattered**: readings are in one tool, firmware and security information in another, maintenance records in a spreadsheet and the knowledge needed to interpret a symptom in manuals that nobody has time to search. Third, the output of automated predictions is often a bare score, and a score that cannot be explained is difficult for a maintenance engineer to trust or to challenge. Fourth, adding a general-purpose AI chatbot to such a system creates new risks: the chatbot may invent facts, may reveal documents that belong to another user, and may follow instructions that are hidden inside an uploaded file."),
            ('p', "Devices of different kinds also behave differently. A pump station and a smart sensor do not share the same normal vibration level or temperature limit, so a single global rule produces either too many false alarms or too few warnings. Finally, many real installations cannot send their data to an external cloud service, either because of cost or because of confidentiality, which rules out hosted AI services."),
            ('p', "**Problem statement:** to design and implement a secure, explainable and locally deployable platform that monitors the health and security of heterogeneous IoT devices, predicts imminent limit breaches before they occur with an explanation for every prediction, and lets authorised users query live data and their own maintenance documents in natural language, with every answer traceable to its sources and without any ability to modify the monitored system."),
        ]),
        ('1.3', 'OBJECTIVE', [
            ('p', "The main objective of the project is to build an end-to-end platform that turns raw device readings and maintenance documents into timely, explainable and trustworthy decisions for maintenance staff. This main objective is divided into the following specific objectives."),
            ('p', "The first group of objectives concerns monitoring. The platform must register devices of several machine types with their own signals and limits, accept readings over a REST API authenticated by a per-device key, detect threshold breaches and silent devices, keep a history of alerts, maintenance work and firmware updates, and push every change to open dashboards within a second."),
            ('p', "The second group concerns prediction. The platform must forecast, for every signal of every device, the probability that its alert limit will be crossed within the next twenty readings; it must raise a predictive alert when that probability is high; it must show exactly why the model produced its value; it must allow a model to be retrained from the telemetry of one machine type, evaluate it on data it has not seen, keep every version, and refuse to activate a model that is not good enough."),
            ('p', "The third group concerns knowledge and the AI assistant. The platform must ingest documents safely, split them into passages, index them for meaning-based and keyword search, and answer questions only from sources that the signed-in user may access. Answers must cite the passages or the live data they are based on, must say when nothing relevant was found, and must treat the text of uploaded documents as data rather than as instructions."),
            ('p', "The last group concerns quality. The platform must protect accounts and device keys, record an audit trail without storing secrets, produce reports in CSV and PDF form, be packaged so that it starts with a single command, and be verified by automated unit, integration and end-to-end tests whose results are reported honestly, including their limits."),
        ]),
        ('1.4', 'SCOPE OF THE PROJECT', [
            ('p', "The project covers the complete software stack of a monitoring platform: a responsive web interface with about twenty screens, a REST API with authentication and two user roles (administrator and viewer), a time-series style telemetry store with automatic expiry, a rule engine with limits that can be overridden for each machine type, heartbeat-based offline detection, a logistic-regression anomaly predictor with versioned retraining and explanations, firmware tracking with simulated roll-outs, a security incident register, signed webhook notifications, an audit log, eight kinds of reports, a document knowledge base and the AI Maintenance Assistant."),
            ('p', "The platform can be used with real devices that can send an HTTP request, and it also contains a simulator that creates eighteen devices of eight machine types with realistic behaviour and faults, so that the whole system can be demonstrated without hardware. The project has been designed to run on a single computer with Docker, with an optional local language model."),
            ('p', "Several things are deliberately outside the scope of this work. The prediction models predict that a **configured threshold will be crossed**; they do not predict equipment failure, because the platform has no failure labels. The model supplied with the system was trained on synthetic data, so its published accuracy describes the synthetic generator and not real machines. The platform does not terminate HTTPS itself (a reverse proxy should do this in production), does not send e-mail or SMS, does not perform optical character recognition on scanned documents, does not implement device protocols such as MQTT or CoAP, and is a single-organisation (not multi-tenant) system. These limits are discussed again in Chapter 6."),
        ]),
        ('1.5', 'MOTIVATION', [
            ('p', "Unplanned downtime of pumps, machine tools and network equipment is expensive, and a large part of it could be avoided if a developing problem were noticed early. The readings that reveal such a problem, for example a slowly rising motor current or a growing vibration, are already being collected by most installations; what is often missing is a tool that watches them continuously, understands that different machines have different limits, and tells the engineer which machine to inspect first and why."),
            ('p', "The second motivation is the recent progress of language models. They make it possible to ask a question such as \"which machines need attention today and what does the manual say about their bearings?\" and to receive an answer in seconds. However, an answer that cannot be checked is dangerous in a maintenance setting. The project therefore looks for a design in which the language model is only the last step: the facts come from fixed, read-only database queries and from retrieved passages, the sources are shown, the model cannot call anything except what the planner selected, and the system can refuse to answer."),
            ('p', "Finally, the project is a practical opportunity to apply, in one coherent system, the topics studied during the programme: web development with a modern front-end framework, REST API design, relational and document databases, caching and messaging, authentication and secure coding, machine learning with a proper evaluation method, containerised deployment and software testing."),
        ]),
    ],
}

CH2 = {
    'num': '2', 'title': 'LITERATURE SURVEY',
    'intro': "This chapter deals with the existing knowledge and practice on which the project is built. It reviews the research and standards on IoT monitoring, predictive maintenance, anomaly detection, explainable models, web security and retrieval-augmented generation, describes how monitoring and maintenance support are done in existing systems and where they fall short, and then presents the proposed system that addresses those shortcomings.",
    'sections': [
        ('2.1', 'LITERATURE REVIEW', [
            ('p', "**Connected monitoring and Industry 4.0.** Lee, Bagheri and Kao [1] describe a five-level architecture for cyber-physical systems in Industry 4.0 (connection, conversion, cyber, cognition and configuration). The lowest level collects data from machines, the middle levels turn the data into information and build a digital model of every machine, and the top levels support human decisions and self-adjustment. IoT Sentinel follows the same layering at a smaller scale: the REST ingest API is the connection level, the rule engine and the predictor are the conversion and cyber levels, and the dashboard, the explanations and the assistant provide the cognition level in which a person takes the decision. The configuration level, which would let the system change a machine by itself, is intentionally left out so that the assistant stays read-only."),
            ('p', "**Predictive maintenance.** Mobley [2] explains that maintenance has moved from repairing machines after a failure (reactive), through servicing at fixed intervals (preventive), to servicing according to the measured condition of the machine (predictive). Condition measurements such as vibration, temperature, pressure and motor current are the basis of the predictive approach. The project uses exactly these signals for its industrial machine types, and it forecasts them so that the engineer is warned while there is still time to plan the work."),
            ('p', "**Anomaly detection.** Chandola, Banerjee and Kumar [3] survey anomaly detection techniques and distinguish point anomalies, contextual anomalies and collective anomalies; a reading that is normal for one machine may be abnormal for another, which is a contextual anomaly. Ahmed, Mahmood and Hu [4] review anomaly detection techniques for network data, which is the setting of the security part of the platform. These surveys support two design decisions. First, limits and models are kept **per machine type**, so that the context is part of the decision. Second, a simple and transparent classifier is preferred to a complex one when the amount of labelled data is small."),
            ('p', "**Explainable prediction.** Logistic regression is described in detail by Hosmer, Lemeshow and Sturdivant [5]. Because the model is linear in its features, the contribution of every feature to the log-odds of the prediction is exactly the product of its weight and its standardised value. IoT Sentinel uses this property to show an exact explanation for every prediction instead of an approximate one, and it uses a time-ordered train-and-test split so that the reported evaluation reflects how the model will be used on future data."),
            ('p', "**Web architecture and authentication.** Fielding [6] defines the REST architectural style (stateless requests, uniform resources and standard methods), which is the style of the platform's API. JSON Web Tokens are specified in RFC 7519 [7] and are used for the session of a signed-in user, while devices use a separate secret key that is stored only as a hash. The OWASP list of the ten most critical risks for applications built on large language models [8] was used as a checklist for the assistant, in particular the risks of prompt injection, insecure handling of model output, excessive agency and sensitive information disclosure."),
            ('p', "**Retrieval-augmented generation.** Lewis and co-authors [9] show that a generator that is conditioned on passages retrieved from an external collection gives more factual answers to knowledge-intensive questions than a generator that relies only on what is stored in its parameters, and that the retrieved passages provide a form of provenance. The project applies this idea to maintenance documents. For the retrieval step, the Hierarchical Navigable Small World graph of Malkov and Yashunin [10] is the index that pgvector offers for approximate nearest-neighbour search, and reciprocal rank fusion, proposed by Cormack, Clarke and Büttcher [11], is used to merge the ranking obtained from embeddings with the ranking obtained from keyword search. The language model family used by default (Qwen2.5) is described in its technical report [12] and is based on the transformer architecture of Vaswani and co-authors [13]."),
            ('p', "**Security of language-model applications.** Greshake and co-authors [14] demonstrate that instructions hidden in data that an application retrieves (so-called indirect prompt injection) can take control of an LLM-integrated application. This is the reason why, in IoT Sentinel, the text of documents is never placed in the system prompt, is wrapped in explicit delimiters, has its look-alike markers and citations neutralised, and why the planner that chooses the tools is a deterministic program and not the model. The same study motivates the rule that the assistant has no tool that can write."),
            ('p', "Taken together, the literature supports the central design of the project: monitor the condition of machines with context-specific limits, forecast with a model whose reasoning can be inspected, ground every generated answer in retrieved or measured evidence, and treat both user input and retrieved text as untrusted."),
        ]),
        ('2.2', 'EXISTING SYSTEM', [
            ('p', "In many small and medium installations, device monitoring is still done by a combination of manual rounds, vendor-specific tools for each class of equipment and spreadsheets in which readings, inspection dates and repairs are recorded. Maintenance procedures are kept in printed manuals or in shared folders, and the engineer searches them by hand when a problem appears."),
            ('p', "Larger installations use general IoT and cloud platforms (for example the device-management services offered by the major cloud providers, or open-source dashboards such as ThingsBoard). These platforms are good at collecting telemetry and drawing charts, and they usually offer threshold rules. Predictive features, explanations, document search and conversational assistance, where available, are separate paid services that require sending data to an external provider."),
            ('p', "The existing approaches therefore share the following limitations. Alerts are raised only after a fixed limit has been crossed. A single limit is often applied to devices that do not behave alike. Predictions, when they exist, are not explained. Operational data, security events, firmware status and maintenance knowledge live in different places, so the engineer must assemble the picture by hand. General-purpose chatbots that are added on top of such systems are not grounded in the organisation's own documents and live data, can reveal information to users who should not see it, and can be steered by text hidden in files. Finally, solutions that depend on an external cloud are unsuitable where data must stay on the premises."),
        ]),
        ('2.3', 'PROPOSED SYSTEM', [
            ('p', "The proposed system, IoT Sentinel, is a single platform that removes these limitations. It monitors devices through limits that are defined per machine type, detects both threshold breaches and silent devices, and adds a predictive layer that warns before a limit is crossed. Each prediction is explained with exact feature contributions, each trained model is versioned and can be rolled back, and a retrained model is activated only when it passes a validation gate on data it has not seen."),
            ('p', "Operational data, firmware compliance, security incidents, maintenance history and the audit trail are kept in one system. Maintenance documents are added to a private-by-default knowledge base and are searched with a combination of meaning-based and keyword search. The AI Maintenance Assistant answers questions from live data and from those documents, always shows its sources, refuses to guess when nothing relevant is found, can never modify the system, and runs entirely on the local machine. Reports in CSV and PDF form are available for management and for audits."),
            ('table', 'Table 2.1: Existing approaches compared with the proposed system',
             ['Aspect', 'Existing approaches', 'Proposed system (IoT Sentinel)'],
             [
                 ['Alerting', 'Fixed threshold, after the event', 'Per-type thresholds plus a prediction before the event'],
                 ['Explanation of predictions', 'Rarely available, or a bare score', 'Exact per-feature contribution, model version and data source shown'],
                 ['Model management', 'Replaced without evaluation', 'Versioned, time-ordered evaluation, validation gate, rollback'],
                 ['Maintenance knowledge', 'Separate manuals and folders', 'Uploaded to a searchable, access-controlled knowledge base'],
                 ['Question answering', 'None, or an ungrounded chatbot', 'Grounded in live data and documents, with verifiable citations'],
                 ['Data privacy', 'Often sent to an external service', 'Models and data stay on the local machine'],
                 ['Chatbot safety', 'No defence against hidden instructions', 'Sources treated as data, read-only tools, deterministic planner'],
                 ['Traceability', 'Limited logs', 'Audit log of security-relevant actions without secrets'],
                 ['Reporting', 'Manual export', 'Eight report types as streamed CSV and PDF, simulated data marked'],
             ], [1.4, 2.2, 2.7]),
        ]),
    ],
}

CH3 = {
    'num': '3', 'title': 'SYSTEM ANALYSIS',
    'intro': "This chapter deals with the analysis of what the system must do and what it needs in order to run. It lists the functional and non-functional requirements, identifies the users and the constraints under which the system works, and specifies the software and the hardware that were used to develop, test and run the platform.",
    'sections': [
        ('3.1', 'SYSTEM REQUIREMENTS', [
            ('p', "Two kinds of users interact with the system. An **administrator** can change everything: register and deactivate devices, edit limits and machine types, start retraining, manage users, webhooks and shared documents, and read the audit log. A **viewer** can read dashboards, alerts, predictions, reports and shared documents, can upload private documents and use the assistant, but cannot change any monitored data. The first account created on a fresh installation becomes the administrator. A device is a third kind of actor: it is not a person, it authenticates with a secret key, and it can only send readings."),
            ('p', "The functional requirements that were derived from the objectives are summarised in Table 3.1."),
            ('table', 'Table 3.1: Functional requirements',
             ['ID', 'Requirement'],
             [
                 ['FR1', 'Users register and sign in; passwords are stored hashed; sessions expire; the first user becomes administrator; viewers are read-only on the server.'],
                 ['FR2', 'Administrators register devices of defined machine types, receive a device key once, rotate the key, deactivate a device without deleting its history, and delete a device with its data.'],
                 ['FR3', 'Devices send readings of up to eight signals (temperature, CPU, memory, battery, signal, vibration, pressure, motor current) and heartbeats; invalid values are rejected.'],
                 ['FR4', 'The system evaluates alert limits that apply to the machine type, opens, refreshes and automatically resolves threshold alerts, and raises a critical alert when a device stops reporting.'],
                 ['FR5', 'The system forecasts the probability of crossing each limit within the next 20 readings, raises predictive alerts, estimates time to breach, and stores prediction snapshots with their explanation.'],
                 ['FR6', 'Administrators retrain a model from the telemetry of a machine type; the result is evaluated on newer data, stored as a version, activated only if it passes the gate, and can be rolled back.'],
                 ['FR7', 'The system tracks firmware releases and compliance, performs simulated roll-outs, keeps a security incident register and per-device maintenance history.'],
                 ['FR8', 'Alerts, incidents and changes reach open browsers by push updates; critical events are sent to signed webhooks.'],
                 ['FR9', 'Users upload PDF, DOCX, TXT, Markdown and CSV documents, which are validated, indexed, searchable, downloadable and deletable; private by default, shareable by an administrator.'],
                 ['FR10', 'The AI assistant answers questions from live data and accessible documents, streams the answer, shows verifiable citations, keeps owner-only conversation history, and cannot change data.'],
                 ['FR11', 'Users preview reports and download them as CSV or PDF; simulated devices are marked.'],
                 ['FR12', 'Administrators read and export an audit log of sign-ins, administrative changes, document access, assistant tool use and report exports.'],
                 ['FR13', 'A built-in simulator creates demonstration devices and lets the operator pause the fleet or trigger a fault.'],
             ], [0.6, 5.7]),
            ('p', "The non-functional requirements describe how well the system must perform its work and are summarised in Table 3.2."),
            ('table', 'Table 3.2: Non-functional requirements',
             ['Quality', 'Requirement'],
             [
                 ['Security', 'Bcrypt password hashing; signed tokens with a 12-hour life; device keys stored only as SHA-256 hashes; role checks on the server; rate limits for the API, devices, logins, uploads, reports and assistant; protection against server-side request forgery in webhooks; CSV formula neutralisation; upload validation by file content.'],
                 ['Privacy', 'Documents private by default; the same access rule applied to listing, search, download and retrieval; conversations visible only to their owner; local language model, so that no data leaves the machine.'],
                 ['Reliability', 'Readings are stored before analysis; failures of the language model or of Redis degrade a feature but do not stop monitoring; uploads are queued and retried; models are never replaced by a worse one.'],
                 ['Performance', 'Dashboard updates by push within about a second; large exports are streamed in batches so memory does not grow with the number of rows; old telemetry expires automatically.'],
                 ['Honesty', 'Probabilities mean a threshold will be crossed, not that equipment will fail; models trained on synthetic data are labelled; simulated devices are marked in reports and in assistant answers.'],
                 ['Usability', 'Responsive interface with light and dark themes, clear empty, loading and error states, confirmation before destructive actions.'],
                 ['Maintainability', 'TypeScript throughout, versioned database migrations for the relational part, automatic index creation for the document part, automated tests and static checks, documentation of architecture and operation.'],
                 ['Portability', 'Complete stack started with Docker Compose; configuration only through environment variables; no secrets in the source code.'],
             ], [1.2, 5.1]),
            ('p', "The system works under the following constraints and assumptions. The language model and the embedding model are small enough to run on a consumer computer; the default chat model needs about five gigabytes of graphics memory, and a smaller model can be selected by configuration. Devices can reach the API over HTTP. Time is measured by the server clock. Model accuracy figures can only be interpreted for the data the model was trained on."),
        ]),
        ('3.2', 'SOFTWARE AND HARDWARE REQUIREMENTS', [
            ('p', "The software used to build and run the platform is listed in Table 3.3. All of it is free or open source."),
            ('table', 'Table 3.3: Software requirements',
             ['Software', 'Version used', 'Purpose'],
             [
                 ['Node.js', '24.x (22 or later supported)', 'Runtime of the REST API and of the build tools'],
                 ['TypeScript', '7.0', 'Typed language for the API and the front end'],
                 ['Express.js', '5.2', 'REST API framework'],
                 ['React / React Router', '19.3 / 7.18', 'User interface'],
                 ['Vite', '8.3', 'Front-end build tool and development server'],
                 ['TanStack Query, Recharts', '5.104, 3.10', 'Data fetching and caching; charts'],
                 ['MongoDB', '7.0 (Node.js driver 7.7)', 'Operational data store'],
                 ['PostgreSQL with pgvector', '16 with pgvector 0.8.1', 'Knowledge base, embeddings and conversations'],
                 ['Redis', '7', 'Heartbeats, latest values, caches, rate limits, publish/subscribe'],
                 ['Ollama', '0.33', 'Local runtime for the language and embedding models'],
                 ['Language models', 'qwen2.5:7b (default), phi4-mini; qwen3-embedding:0.6b', 'Answer generation; document and query embeddings (1024 dimensions)'],
                 ['Libraries', 'jsonwebtoken, bcryptjs, zod, helmet, multer, pdfjs-dist, mammoth, csv-parse, pdfkit', 'Authentication, validation, security headers, uploads, document parsing, PDF reports'],
                 ['Docker / Docker Compose', '29.7 / 5.4', 'Packaging and start-up of the five services'],
                 ['Vitest, Supertest, Testing Library, Playwright', '5.0, 7.3, 16.3, 1.64', 'Unit, API, component and end-to-end tests'],
                 ['Web browser', 'Google Chrome (current)', 'Using the application; end-to-end tests'],
                 ['Git and GitHub', '-', 'Version control and continuous integration'],
             ], [1.9, 1.9, 2.5]),
            ('p', "The hardware on which the system was developed and tested is given in Table 3.4 together with the minimum configuration that is sufficient for the monitoring features and the recommended configuration for the AI assistant."),
            ('table', 'Table 3.4: Hardware requirements',
             ['Item', 'Development and test machine', 'Minimum (monitoring only)', 'Recommended (with assistant)'],
             [
                 ['Processor', 'Laptop-class multi-core CPU', 'Dual-core, 2 GHz', '4 or more cores'],
                 ['Memory', '15.8 GB', '4 GB', '16 GB'],
                 ['Graphics', 'NVIDIA GeForce RTX 4050 Laptop GPU, 6 GB', 'Not required', 'GPU with 6 GB or more, or a smaller model on the CPU'],
                 ['Storage', 'SSD', '5 GB free', '15 GB free (models, images, data volumes)'],
                 ['Operating system', 'Windows 11 with Docker Desktop', 'Windows, Linux or macOS with Docker', 'Same'],
                 ['Network', 'Local', 'Local network to the devices', 'Same; HTTPS reverse proxy for production'],
             ], [1.2, 2.0, 1.5, 1.6]),
            ('p', "On the development machine the default chat model (qwen2.5:7b) did not fit into the six gigabytes of graphics memory together with the desktop, so the smaller phi4-mini model was used for the live tests and for the screenshots of this report. The model is selected by a single configuration variable."),
        ]),
    ],
}
